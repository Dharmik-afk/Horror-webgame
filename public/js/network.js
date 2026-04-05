// ─────────────────────────────────────────────
//  network.js
//  Native WebSocket client — relay only.
//  Connects to the Go game server at ws://host:9000/ws.
//
//  Public API
//  ─────────────────────────────────────────────
//  connect(serverUrl)        async, idempotent
//  sendMove(x, y, angle)     throttled 20 Hz, dead-zoned
//  getPeers()                → live Map<id, {x,y,angle}>
//  onPeerUpdate(cb)          cb(id, state) — join + update
//  onPeerLeave(cb)           cb(id)
//  getSelfId()               → string | null
//  isConnected()             → boolean
//                              true when socket is open AND
//                              the server has sent self:init.
//                              Safe to call every frame (no GL
//                              or I/O cost).  Read by main.js
//                              to populate the debug overlay
//                              NETWORKING section.
//
//  Wire protocol (JSON, matches gameserver.go)
//  ─────────────────────────────────────────────
//  Server → Client
//
//    { "type":"init", "id":"<id>",
//      "players": { "<id>": {x,y,angle}, ... } }
//      Own entry excluded.  players is a map.
//      Fires onPeerUpdate for every seed peer.
//
//    { "type":"state",
//      "players": [{id,x,y,angle}, ...],
//      "npcs": [] }
//      Full-roster snapshot excluding sender.
//      Diff against _peers: new entries fire
//      onPeerUpdate; removed entries are left to
//      "leave" messages — the server does emit those.
//
//    { "type":"leave", "id":"<id>" }
//      Fires onPeerLeave, removes from _peers.
//
//  Client → Server
//
//    { "type":"move", "x":f, "y":f, "angle":f }
//
//  Reconnection
//  ─────────────────────────────────────────────
//  On unexpected close, exponential back-off retry
//  up to MAX_RETRIES (5) attempts.  After that the
//  module goes silent — single-player continues.
//  Retry counter resets on a successful open.
// ─────────────────────────────────────────────

// ── Latency Monitor ───────────────────────────────────────────────

const PING_TIMEOUT_MS = 2000;

class WebSocketLatencyMonitor {
  constructor(socket) {
    this.socket = socket;
    this.pingId = 0;
    this.pings  = new Map(); // id → sendTime
    this.timer  = null;
    this.latency = 0;
    this.onLatencyUpdate = null;
  }

  start(intervalMs = 1000) {
    this.stop();
    this.timer = setInterval(() => this.ping(), intervalMs);
    // Initial ping
    this.ping();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.pings.clear();
  }

  ping() {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    
    // Aggressive stall detection: if a ping is pending longer than its own timeout,
    // we don't necessarily wait for the Map to fill up. 
    // If we already have 2 pending, we are definitely stalling (at 1s interval).
    if (this.pings.size >= 2) {
      this.latency = 0;
      this._fireLatency(0);
      return;
    }

    const id = ++this.pingId;
    this.pings.set(id, performance.now());
    this.socket.send(JSON.stringify({ type: 'ping', id }));

    // Timeout per individual ping
    setTimeout(() => {
      if (this.pings.has(id)) {
        this.pings.delete(id);
        // If all pending pings are now gone (timed out), we are officially stalled.
        if (this.pings.size === 0) {
          this.latency = 0;
          this._fireLatency(0);
        }
      }
    }, PING_TIMEOUT_MS);
  }

  handlePong(id) {
    const sendTime = this.pings.get(id);
    if (sendTime === undefined) return;
    this.pings.delete(id);
    
    const calculated = performance.now() - sendTime;
    
    // Stricter filtering: if latency > 2s, it's a "ghost" of a stalled connection.
    // Discard it to prevent UI spikes.
    if (calculated > PING_TIMEOUT_MS) {
      if (this.pings.size === 0) {
        this.latency = 0;
        this._fireLatency(0);
      }
      return;
    }

    this.latency = calculated;
    this._fireLatency(this.latency);
  }

  _fireLatency(val) {
    if (this.onLatencyUpdate) {
      try { this.onLatencyUpdate(val); } 
      catch (e) { console.error('[network.js] Latency callback error:', e); }
    }
  }

  getLatency() { return this.latency; }
}

// ── Internal state ────────────────────────────────────────────────
let _socket     = null;       // WebSocket | null
let _selfId     = null;       // string | null
let _connected  = false;
let _serverUrl  = '';         // stored for reconnect
let _retries    = 0;
const _peers           = new Map();   // id → { x, y, angle }
const _peerUpdateCbs   = [];
const _peerLeaveCbs    = [];

// ── Latency state ─────────────────────────────────────────────────
let _latencyMonitor    = null;
let _currentLatency     = 0;
const _latencyCbs       = [];

// ── Network Status ────────────────────────────────────────────────
// Statuses: 'offline', 'connecting', 'connected', 'reconnecting'
let _status            = 'offline';
const _statusCbs       = [];

function _setStatus(newStatus) {
  if (_status === newStatus) return;
  _status = newStatus;
  
  // If not fully connected, reset the latency so it doesn't get stuck.
  if (_status !== 'connected') {
    _currentLatency = 0;
    _broadcastLatency(0);
  }

  console.info(`[network.js] Status: ${newStatus}`);
  _broadcastStatus(newStatus);
}

function _broadcastLatency(val) {
  for (const cb of _latencyCbs) {
    try { cb(val); } 
    catch (e) { console.error('[network.js] Latency consumer error:', e); }
  }
}

function _broadcastStatus(status) {
  for (const cb of _statusCbs) {
    try { cb(status); } 
    catch (e) { console.error('[network.js] Status consumer error:', e); }
  }
}

// ── Throttle / dead-zone state ────────────────────────────────────
const SEND_INTERVAL_MS = 50;          // 20 Hz cap
const POSITION_EPSILON = 0.0001;
const ANGLE_EPSILON    = 0.0001;

let _lastSendTime  = 0;
let _lastSentX     = null;
let _lastSentY     = null;
let _lastSentAngle = null;

// ── Reconnect ─────────────────────────────────────────────────────
const MAX_RETRIES   = 5;
const BASE_DELAY_MS = 1000;

function _scheduleReconnect() {
  if (_retries >= MAX_RETRIES) {
    console.warn('[network.js] Max reconnection attempts reached — staying offline.');
    _setStatus('offline');
    return;
  }
  const delay = BASE_DELAY_MS * Math.pow(2, _retries);
  _retries++;
  console.info(`[network.js] Reconnecting in ${delay} ms (attempt ${_retries}/${MAX_RETRIES})…`);
  _setStatus('reconnecting');
  setTimeout(() => _open(_serverUrl), delay);
}

// ── Message dispatch ──────────────────────────────────────────────
function _handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.warn('[network.js] Non-JSON message — ignored:', raw);
    return;
  }

  // Intercept pong messages for latency monitoring.
  if (msg.type === 'pong' && _latencyMonitor) {
    _latencyMonitor.handlePong(msg.id);
    return;
  }

  switch (msg.type) {

    case 'init': {
      // msg.id — own socket ID assigned by server.
      // msg.players — map { "<id>": {x,y,angle,vx,vy} } of existing peers (self excluded).
      _selfId = msg.id;
      console.info('[network.js] self:init  id =', _selfId);
      _setStatus('connected');

      for (const [id, state] of Object.entries(msg.players ?? {})) {
        const playerstate = {
          pos      : { x: state.x, y: state.y },
          angle    : state.angle, 
          velocity : { x: state.vx ?? 0, y: state.vy ?? 0 },
          id       : id 
        }
        _peers.set(id, playerstate);
        for (const cb of _peerUpdateCbs) cb(id, state);
      }
      break;
    }

    case 'state': {
      // msg.players — array [{id,x,y,angle,vx,vy}] of ALL peers excluding the sender.
      // Treat each entry as a join-or-update.  The server handles departures
      // via explicit "leave" messages — do not prune missing peers here, as
      // the array only covers the peers that have sent at least one move.
      for (const entry of msg.players ?? []) {
        const state = {
          pos      : { x: entry.x, y: entry.y },
          angle    : entry.angle, 
          velocity : { x: entry.vx ?? 0, y: entry.vy ?? 0 },
          id       : entry.id
        };
        if (state.id === _selfId) {
          continue
        }
        _peers.set(entry.id, state);

        for (const cb of _peerUpdateCbs) cb(entry.id, state);
      }
      break;
    }
    // TODO : repond to server correcting client position 
    case 'correction' : {

    }

    case 'leave': {
      const id = msg.id;
      if (_peers.has(id)) {
        _peers.delete(id);
        for (const cb of _peerLeaveCbs) cb(id);
      }
      break;
    }

    default:
      // Silently ignore unknown types — forward-compatible.
      break;
  }
}

// ── Socket lifecycle ──────────────────────────────────────────────
function _open(serverUrl) {
  // Convert http(s):// → ws(s):// and append /ws endpoint.
  const wsUrl = serverUrl.replace(/^http/, 'ws').replace(/\/?$/, '/ws');

  console.info('[network.js] Connecting to', wsUrl);
  _setStatus('connecting');

  const sock = new WebSocket(wsUrl);

  sock.addEventListener('open', () => {
    _connected = true;
    _retries   = 0;
    _socket    = sock;
    console.info('[network.js] Connected.');

    // Start latency monitor
    _latencyMonitor = new WebSocketLatencyMonitor(sock);
    _latencyMonitor.onLatencyUpdate = (latency) => {
      _currentLatency = latency;
      for (const cb of _latencyCbs) cb(latency);
    };
    _latencyMonitor.start(3000); // every 3 seconds
  });

  sock.addEventListener('message', e => _handleMessage(e.data));

  sock.addEventListener('close', e => {
    _connected = false;
    _socket    = null;
    _selfId    = null;

    if (_latencyMonitor) {
      _latencyMonitor.stop();
      _latencyMonitor = null;
    }

    console.info(`[network.js] Closed (code=${e.code} wasClean=${e.wasClean}).`);
    if (!e.wasClean) {
      _scheduleReconnect();
    } else {
      _setStatus('offline');
    }
  });

  sock.addEventListener('error', err => {
    // 'error' is always followed by 'close' — let the close handler
    // decide whether to reconnect.
    console.warn('[network.js] WebSocket error:', err);
  });
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Establish the WebSocket connection.  Idempotent — safe to call
 * multiple times; subsequent calls after the first are no-ops.
 *
 * @param {string} serverUrl  e.g. 'http://localhost:9000'
 */
export function connect(serverUrl) {
  if (_socket) return;   // already connected or connecting
  _serverUrl = serverUrl;
  _retries   = 0;

  _open(serverUrl);
}
/**
 * Sends an idle update to the server.
 * To keep a consistent connection to the gameserver, it needs to send an idle update.
 * Without consistent updates, the server connection will be lost and the player will be kicked out.
 */
 function sendIdle(){
  if (!_connected || !_socket) return;
  _socket.send(JSON.stringify({type: 'idle'}))
}
/**
 * Send a position update to the server.  Called every frame by
 * main.js after player.update().  Internally throttled to 20 Hz
 * and dead-zoned — no extra logic needed at the call site.
 *
 * @param {Player} player
 */
export function sendMove(player) {
  if (!_connected || !_socket) return;
  const x = player.pos.x;
  const y = player.pos.y;
  const angle = player.angle
  const now = performance.now();
  const vx = player.velocity.x;
  const vy = player.velocity.y;
  if (now - _lastSendTime < SEND_INTERVAL_MS) return;

  // Dead-zone: skip if nothing meaningful changed.
  if (
    _lastSentX !== null &&
    Math.abs(x     - _lastSentX)     < POSITION_EPSILON &&
    Math.abs(y     - _lastSentY)     < POSITION_EPSILON &&
    Math.abs(angle - _lastSentAngle) < ANGLE_EPSILON
  ) {sendIdle(); return}

  _lastSendTime  = now;
  _lastSentX     = x;
  _lastSentY     = y;
  _lastSentAngle = angle;

  _socket.send(JSON.stringify({
    type: 'move',
    x,
    y,
    angle,
    vx,
    vy,
  }));
}
/**
 * Returns the live peers Map.  Do NOT mutate the returned reference.
 * @returns {Map<string,{ pos : {x:number, y:number}, angle:number}>}
 */
export function getPeers() {
  return _peers;
}

/**
 * Register a callback fired when a peer joins or updates position.
 * Also fires once per existing peer when self:init is received.
 * @param {(id: string, state: {{x,y},angle}) => void} cb
 */
export function onPeerUpdate(cb) {
  console.log("update received")
  _peerUpdateCbs.push(cb);
}

/**
 * Register a callback fired when a peer disconnects.
 * @param {(id: string) => void} cb
 */
export function onPeerLeave(cb) {
  _peerLeaveCbs.push(cb);
}

/**
 * Returns own WebSocket ID assigned by the server, or null before
 * the init message arrives.
 * @returns {string | null}
 */
export function getSelfId() {
  return _selfId;
}

/**
 * Returns true when the WebSocket is open and the server has
 * acknowledged the connection with a self:init message.
 * False before connect(), during reconnect back-off, or after
 * the connection is lost.
 * @returns {boolean}
 */
export function isConnected() {
  return _connected && _selfId !== null;
}

/**
 * Returns the current WebSocket latency in milliseconds.
 * @returns {number}
 */
export function getLatency() {
  return _currentLatency;
}

/**
 * Register a callback fired when the latency is updated.
 * @param {(latency: number) => void} cb
 */
export function onLatencyUpdate(cb) {
  _latencyCbs.push(cb);
}

/**
 * Returns the current network status.
 * @returns {string}
 */
export function getStatus() {
  return _status;
}

/**
 * Register a callback fired when the network status changes.
 * @param {(status: string) => void} cb
 */
export function onStatusUpdate(cb) {
  _statusCbs.push(cb);
}

