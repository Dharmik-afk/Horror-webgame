// ─────────────────────────────────────────────
//  main.js
//  Entry point.  Wires all modules together and
//  owns the single requestAnimationFrame loop.
//
//  Nothing in here should contain game logic —
//  it only calls into the appropriate modules.
//
//  Startup sequence (top-level await, ES module)
//  ────────────────────────────────────────────
//  1. loadLevel()            — populates WALLS_FLAT / WALLS_COUNT /
//                              SPAWN before the renderer or player
//                              are initialised.
//  2. new Player()           — reads SPAWN for starting position.
//  3. initInput(player)      — wires keyboard / touch / pointer lock.
//  4. initRenderer()         — compiles shaders, uploads segment
//                              texture, installs resize callback.
//  5. loadTextureAtlas()     — uploads wall textures to TEXTURE_2D_ARRAY.
//  6. autoDetectResolution() — measures rAF cadence per tier and
//                              commits the best resolution.  Uses
//                              top-level await so the RAF loop does
//                              NOT start until this resolves.
//  7. netConnect()           — non-blocking WebSocket handshake.
//                              Derives game server URL from
//                              window.location.hostname:9000.
//                              sendMove() is a no-op until connected,
//                              so the game loop can start immediately.
//  8. window._showStart()    — reveals the start overlay; the RAF
//                              loop fires only after the player
//                              clicks Play.
//
//  window.__raycaster bridge
//  ────────────────────────────────────────────
//  Exposes engine controls to the non-module ui.js script.
//  All methods guard against pre-start / pre-connection state.
//
//    start()              — kicks off the RAF loop (idempotent).
//    setPaused(bool)      — freezes / resumes the RAF loop.
//                           No-op before start() is called.
//    setResolution(w, h)  — forwarded directly to canvas.js.
//    setDebug(bool)       — maps to _debugMode:
//                           true  → Math.max(1, _debugMode)
//                           false → 0; clears HUD dirty region.
//    setPerf(bool)        — maps to _debugMode:
//                           true  → 2
//                           false → 1 (if mode was 2).
//                           Gates castRays() timing overhead.
//    getDebugMode()       — returns _debugMode (0|1|2) so the
//                           settings panel can sync checkboxes.
//    setMinimapVisible(b) — shows / hides the minimap; clears the
//                           HUD dirty region immediately on hide.
//    setFov(deg)          — updates the camera plane in renderer.js.
//    setFogDist(dist)     — updates the u_fogDist uniform directly.
//    detectedResolution   — { w, h, avgMs } from autoDetect.
//
//  Debug mode state machine (_debugMode)
//  ────────────────────────────────────────────
//  0 — off      : no overlay, bare castRays draw (zero overhead)
//  1 — standard : four-section panel, no perf timing rows
//  2 — verbose  : panel + full timing breakdown in PERFORMANCE
//
//  Transitions
//    F3          → cycles 0 → 1 → 2 → 0
//    Shift+F3    → forces 0 immediately
//    Shift+1–4   → toggles individual section collapse while mode ≥ 1
//    setDebug    → bool maps to mode 0 / max(1,current)
//    setPerf     → bool maps to mode 2 / 1
//
//  GPU timing — two paths, both isolated to castRays()
//  ────────────────────────────────────────────
//  castRays(player, measure) is called with
//  measure = (_debugMode >= 2) each frame.
//
//  Path A (EXT_disjoint_timer_query_webgl2):
//    castRays() returns null.  main.js polls the
//    previous frame's result via pollGPUTimer().
//    No pipeline stall regardless of measure.
//
//  Path B (gl.finish fallback):
//    measure=false → bare draw, returns null, no stall.
//    measure=true  → draw + gl.finish(), returns ms.
//    The stall is fully inside castRays() — minimap
//    and debug timings start after it returns.
//
//  debugData object (passed to drawDebugOverlay)
//  ────────────────────────────────────────────
//  Built in render() every frame when _debugMode ≥ 1.
//  All ring averages are read at the point of use so
//  hud.js has no dependency on the ring buffers.
//
//    frameMs      — total frame rolling avg ms
//    gpuMs        — GPU shader rolling avg ms
//    renderW/H    — current WebGL canvas size (pixels)
//    fov          — current FOV degrees (getFov())
//    fogDist      — current fog distance (getFogDist())
//    gpuInfo      — GPU name string (static after init)
//    netConnected — boolean (isConnected())
//    selfId       — string | null (getSelfId())
//    peerCount    — number (getPeers().size)
//    timings      — null when mode < 2; verbose object
//                   when mode == 2.  See hud.js header
//                   for full field documentation.
//
//  frameMs ring buffer
//  ────────────────────────────────────────────
//  Total wall-clock cost of one engine tick:
//  from the top of engine() to the end of render(),
//  measured on the CPU.  This is the number that
//  directly explains dropped frames — if it
//  consistently exceeds 16.67 ms the RAF loop will
//  miss its vsync slot.
//
//  CPU ring buffers (update / minimap / debug / frameMs / rafInterval)
//  share _ringIdx, advancing once per frame after all CPU slots
//  are written so all averages reflect the same set of frames.
//  GPU ring (castRaysGPU) uses _gpuRingIdx, advancing only when
//  a sample actually arrives (one frame delayed on Path A).
//
//  Network — Phase 1
//  ────────────────────────────────────────────
//  network.js owns the WebSocket connection and the
//  peers Map.  main.js interacts with it in two ways:
//
//  1. netConnect('http://localhost:9000')
//       Called once after autoDetectResolution resolves.
//       Non-blocking — the handshake happens asynchronously
//       and does not delay the RAF loop.
//
//  2. sendMove(x, y, angle)  — called every frame,
//       AFTER player.update() and BEFORE render().
//       Throttling (20 Hz cap) and dead-zone filtering
//       are handled entirely inside network.js.
//
//  3. getSelfId() / getPeers() / isConnected()
//       Read each frame to populate the NETWORKING
//       section of drawDebugOverlay().  Zero overhead
//       when _debugMode is 0.
//
//  Peer callbacks (Phase 1 — partial wiring):
//    onPeerUpdate — intentional no-op.  Phase 2 will
//      use this to update the renderer's sprite list.
//    onPeerLeave  — logs to console so disconnections
//      are visible during development.
//
//  Known gaps:
//    • No reconnection UI after MAX_RETRIES (5) are
//      exhausted — game silently becomes single-player.
//    • No peer interpolation (Phase 2+).
//    • No peer sprites rendered yet (Phase 2).
// ─────────────────────────────────────────────

import { Player } from './js/player.js';
import { init as initInput } from './js/input.js';
import {
  initRenderer, castRays, present,
  pollGPUTimer, gpuTimerSupported,
  getGPUInfo, autoDetectResolution,
  setFov, setFogDist, getFov, getFogDist,
  loadTextureAtlas,
  setFloorMat, setCeilMat,
} from './js/renderer.js';
import {
  initSpriteRenderer,
  loadSpriteAtlas,
  drawSprites
} from './js/sprite_renderer.js';
import {
  drawMinimap, clearMinimap, drawCrosshair,
  drawDebugOverlay, clearDebugOverlay,
  getDebugSections, setDebugSectionCollapsed
} from './js/hud.js';
import { getW, getH, setResolution } from './js/canvas.js';
import {
  loadLevel, SPAWN, TEXTURES, FLOOR_MAT, CEIL_MAT, castCenterRay,
  WALLS_COUNT, MAX_SEGMENTS, WORLD_W, WORLD_H
} from './js/map.js';
import {
  connect as netConnect,
  sendMove,
  onPeerUpdate,
  onPeerLeave,
  getSelfId,
  getPeers,
  isConnected,
} from './js/network.js';

// ── Bootstrap ────────────────────────────────────────────────────
// Load level first — populates WALLS_FLAT, WALLS_COUNT, and SPAWN
// before initRenderer() builds the segment texture and before the
// Player reads its starting position.
await loadLevel('./levels/level-01.json');

const player = new Player(SPAWN.x, SPAWN.y);
player.angle = SPAWN.angle;
initInput(player);
initRenderer();
initSpriteRenderer();
await Promise.all([
  loadTextureAtlas(TEXTURES),
  loadSpriteAtlas('./resource/entity.png')
]);
setFloorMat(FLOOR_MAT);
setCeilMat(CEIL_MAT);

// ── Test Entity ──────────────────────────────────────────────────
// A static NPC placed in front of the spawn point for visual testing.
const testEntities = [
  { pos: { x: SPAWN.x + 2, y: SPAWN.y }, angle: 0 }
];

// Auto-detect the best render resolution for this device.
// Top-level await pauses module evaluation — the RAF loop below
// does not start until the resolution is committed.
// Detection measures rAF cadence (not gl.finish) so compositor
// transfer cost is included in the measurement.
const { w: detW, h: detH, avgMs: detAvgMs } = await autoDetectResolution(player);
console.info(
  `[main.js] auto-detected ${detW}×${detH}  (rAF avg ${detAvgMs.toFixed(1)} ms)`
);

// Notify the settings panel of the detected resolution.
// window._onResDetected is defined by the inline script (non-module)
// which has already run by this point — modules are deferred.
// It injects the "recommended" badge and selects the item.
window._onResDetected?.(`${detW}x${detH}`);

// Show the start menu now that detection is complete and the
// resolution dropdown is fully populated.
window._showStart?.();

// ── Network ──────────────────────────────────────────────────────
// Connect to the game server, deriving the host from the current page.
// This allows LAN testers who reach the file server at e.g.
// http://192.168.x.x:8000 to automatically connect the WebSocket to
// http://192.168.x.x:9000 — no manual URL editing required.
// The call is fire-and-forget: the WebSocket handshake resolves
// asynchronously and does not block the module or delay the RAF
// loop.  sendMove() guards on _connected internally, so
// frames that fire before the handshake completes are safely skipped.
netConnect(`http://${window.location.hostname}:9000`);

// Phase 1 peer callbacks — wired but only partially active.
//
// onPeerUpdate: intentional no-op.  Detailed position logging is
//   handled inside network.js at the WebSocket event level.  This hook
//   will drive renderer sprite updates in Phase 2.
//
// onPeerLeave: logs to console so disconnections are visible during
//   development.  Will also remove the peer sprite in Phase 2.
// onPeerUpdate: extracts peer list from network.js for rendering.
onPeerUpdate((id, state) => {
  void id; void state;
});

onPeerLeave((id) => {
  console.info('[main.js] peer left — removing from scene:', id);
});

// ── FPS counter state ────────────────────────────────────────────
let fps = 0;
let frames = 0;
let lastFpsTime = performance.now();

// ── Started state ─────────────────────────────────────────────────
// False until the player clicks Play on the start menu.
// Guards both the initial rAF kick-off and the setPaused resume path
// so neither can fire the engine loop before the game has begun.
let _started = false;

export function start() {
  if (_started) return;
  _started = true;
  _prevTs = 0;
  requestAnimationFrame(engine);
}

// ── Pause state ──────────────────────────────────────────────────
let _paused = false;

export function setPaused(v) {
  const wasPaused = _paused;
  _paused = !!v;
  // Only restart the loop if the game has actually been started.
  // setPaused(false) is also called when the settings panel closes from
  // the start menu — we must not fire rAF before the player hits Play.
  if (wasPaused && !_paused && _started) {
    _prevTs = 0;   // reset so the first resumed frame uses dt = 1/60
    requestAnimationFrame(engine);
  }
}

// ── Minimap visibility state ──────────────────────────────────────
// On by default — toggled from the settings panel.
let _minimapVisible = true;

export function setMinimapVisible(v) {
  _minimapVisible = !!v;
  // Erase the dirty region immediately when toggling off so no stale
  // pixels persist on the HUD canvas until the next drawMinimap call.
  if (!_minimapVisible) clearMinimap();
}

// ── Debug mode state ──────────────────────────────────────────────
// _debugMode drives both overlay visibility and timing activation:
//   0 — off       : no overlay, bare castRays draw (zero overhead)
//   1 — standard  : debug panel visible, no perf timing
//   2 — verbose   : debug panel + full perf timing section
//
// Transitions:
//   F3            → cycles 0 → 1 → 2 → 0
//   Shift+F3      → forces 0 immediately
//   setDebug(true)  → _debugMode = Math.max(1, _debugMode)
//   setDebug(false) → _debugMode = 0
//   setPerf(true)   → _debugMode = 2
//   setPerf(false)  → if (_debugMode === 2) _debugMode = 1
//
// Settings panel checkboxes call setDebug/setPerf and stay accurate
// because getDebugMode() is exposed on the bridge for sync reads.
let _debugMode = 0;

// _clearDebugHud — centralised clear called whenever debug turns off.
// Erases both the debug panel and the look-at panel dirty regions so
// no stale pixels persist after a mode change.
function _clearDebugHud() {
  clearDebugOverlay();
}

export function setDebug(v) {
  if (v) {
    _debugMode = Math.max(1, _debugMode);
  } else {
    _debugMode = 0;
    _clearDebugHud();
  }
}

export function setPerf(v) {
  if (v) {
    _debugMode = 2;
  } else {
    if (_debugMode === 2) _debugMode = 1;
  }
}

export function getDebugMode() {
  return _debugMode;
}

// ── F3 / Shift+1-4 dev hotkeys ────────────────────────────────────
// Gated behind window._isDevMode (set by ui.js SettingsManager from
// the IS_DEV build flag).  When IS_DEV is false the handler returns
// immediately, keeping these keys available to the browser as normal.
//
// F3        — cycles _debugMode: 0 → 1 → 2 → 0
// Shift+F3  — forces mode 0 immediately
// Shift+1–4 — toggles individual section collapse while mode ≥ 1
//
// The _started guard prevents any action before the game loop begins.
document.addEventListener('keydown', e => {
  if (!_started) return;
  if (!window._isDevMode) return;   // respect IS_DEV build flag

  // ── F3: cycle debug mode ────────────────────────────────────────
  if (e.key === 'F3') {
    e.preventDefault();   // suppress browser devtools shortcut
    if (e.shiftKey) {
      if (_debugMode !== 0) { _debugMode = 0; _clearDebugHud(); }
      return;
    }
    const prev = _debugMode;
    _debugMode = (_debugMode + 1) % 3;   // 0→1→2→0
    if (prev !== 0 && _debugMode === 0) _clearDebugHud();
    return;
  }

  // ── Shift+1-4: toggle individual section collapse ───────────────
  if (e.shiftKey && _debugMode >= 1) {
    const SECTION_KEYS = {
      '1': 'performance',
      '2': 'player',
      '3': 'rendering',
      '4': 'networking',
    };
    const id = SECTION_KEYS[e.key];
    if (id) {
      e.preventDefault();
      setDebugSectionCollapsed(id, !getDebugSections().get(id));
    }
  }
});

// ── Rolling-average ring buffers ──────────────────────────────────
// All timing samples are stored in fixed-size ring buffers so the
// HUD displays a smoothed rolling average rather than raw per-frame
// spikes.  RING_SIZE = 30 gives a ~0.5 s window at 60 fps.
//
// CPU rings (update / minimap / debug / frameMs / rafInterval):
//   Share _ringIdx — advanced once per frame after all CPU slots
//   are written so all averages reflect the same set of frames.
//
// GPU ring (castRaysGPU):
//   Uses a separate _gpuRingIdx because GPU results arrive one
//   frame delayed on Path A (async query) and only when a sample
//   is actually available — it must advance independently.
const RING_SIZE = 30;

const _rings = {
  update: new Float64Array(RING_SIZE),
  minimap: new Float64Array(RING_SIZE),
  debug: new Float64Array(RING_SIZE),
  castRaysGPU: new Float64Array(RING_SIZE),
  frameMs: new Float64Array(RING_SIZE),
  // Raw rAF timestamp delta — unclamped, unscaled.
  // Reflects the true inter-frame interval as seen by the browser
  // scheduler, independent of dt clamping or game logic.
  rafInterval: new Float64Array(RING_SIZE),
};
const _sums = {
  update: 0,
  minimap: 0,
  debug: 0,
  castRaysGPU: 0,
  frameMs: 0,
  rafInterval: 0,
};

let _ringIdx = 0;
let _gpuRingIdx = 0;

// Record a CPU timing sample into the shared ring at _ringIdx.
// Returns the current rolling average for that key.
function _record(key, ms) {
  const ring = _rings[key];
  _sums[key] -= ring[_ringIdx];
  ring[_ringIdx] = ms;
  _sums[key] += ms;
  return _sums[key] / RING_SIZE;
}

// Record a GPU timing sample into the independent GPU ring.
// Called when pollGPUTimer() returns a result (Path A) or when
// castRays() returns a fence measurement (Path B).
function _recordGPU(ms) {
  const ring = _rings.castRaysGPU;
  _sums.castRaysGPU -= ring[_gpuRingIdx];
  ring[_gpuRingIdx] = ms;
  _sums.castRaysGPU += ring[_gpuRingIdx];
  _gpuRingIdx = (_gpuRingIdx + 1) % RING_SIZE;
}

// ── Bridge ────────────────────────────────────────────────────────
// window.__raycaster is the only sanctioned channel between the
// non-module ui.js script and this ES module.  All methods are safe
// to call before the game starts — they update module-level state
// that the RAF loop reads lazily.
window.__raycaster = {
  start,             // kick off the RAF loop (idempotent)
  setPaused,         // freeze / resume the loop
  setResolution,     // change WebGL render resolution
  setDebug,          // drive _debugMode (true → ≥1, false → 0)
  setPerf,           // drive _debugMode (true → 2, false → 1 if was 2)
  getDebugMode,      // returns current _debugMode (0|1|2) for settings sync
  setMinimapVisible, // show / hide the minimap
  setFov,            // update the camera FOV (degrees)
  setFogDist,        // update the fog falloff distance uniform
  // _setDebugSection — called by ui.js DOM overlay via toggleDebugSection.
  // Delegates to setDebugSectionCollapsed imported from hud.js.
  _setDebugSection: setDebugSectionCollapsed,
  detectedResolution: { w: detW, h: detH, avgMs: detAvgMs },
};

// Expose the live section collapse Map so ui.js click overlay can read it
// without an ES-module import.  Written after __raycaster so ui.js
// property-defineProperty shim has already fired.
window.__debugSections = getDebugSections();

// ── Render ───────────────────────────────────────────────────────
function render() {
  // Path A: poll the GPU query submitted by last frame's castRays().
  // Must happen before this frame's castRays() so we are reading
  // the previous query while the new one is being written.
  const pollMs = pollGPUTimer();
  if (pollMs !== null) _recordGPU(pollMs);

  // castRays — measure flag drives timing activation:
  //   Path A, measure=false → bare draw, returns null
  //   Path A, measure=true  → query-wrapped draw, returns null
  //   Path B, measure=false → bare draw, returns null  (no stall)
  //   Path B, measure=true  → fenced draw, returns ms  (stall here only)
  const fenceMs = castRays(player, _debugMode >= 2);
  if (fenceMs !== null) _recordGPU(fenceMs);

  // ── Sprite Pass ────────────────────────────────────────────────
  // 2. Sprite Render Pass (Billboards)
  // Combine static NPCs and network peers for a unified depth-sorted pass.
  const activeEntities = [...testEntities];
  for (const peer of getPeers().values()) {
    activeEntities.push({
      pos: peer.pos,
      angle: peer.angle,
    });
  }

  // Z-Sorting (Descending: Farthest first)
  activeEntities.sort((a, b) => {
    const da = (a.pos.x - player.pos.x) ** 2 + (a.pos.y - player.pos.y) ** 2;
    const db = (b.pos.x - player.pos.x) ** 2 + (b.pos.y - player.pos.y) ** 2;
    return db - da;
  });

  drawSprites(player, activeEntities, getFogDist());

  // 3. Final Presentation (Composite to screen)
  present();

  // Crosshair — drawn every frame at the screen centre, above the 3D
  // view but below minimap and debug panels.
  drawCrosshair();

  // minimap — dirty-region clear is handled inside drawMinimap()
  let t0 = performance.now();
  if (_minimapVisible) drawMinimap(player);
  _record('minimap', performance.now() - t0);

  // debug overlay — build debugData and call drawDebugOverlay.
  // rafMs and displayPeriod are in base debugData (used by the always-
  // visible raf/vsync/pipeline rows).  timings is populated only in
  // verbose mode and carries the per-component breakdown rows.
  if (_debugMode >= 1) {
    const gpuMs = _sums.castRaysGPU / RING_SIZE;
    const frameMs = _sums.frameMs / RING_SIZE;

    // Per-component breakdown — mode 2 only.
    const timings = _debugMode >= 2 ? {
      update: _sums.update / RING_SIZE,
      minimap: _sums.minimap / RING_SIZE,
      debug: _sums.debug / RING_SIZE,
      castRaysFence: !gpuTimerSupported(),
      frameBudget: 1000 / 60,
    } : null;

    const debugData = {
      // Performance
      frameMs,
      gpuMs,
      rafMs: _sums.rafInterval / RING_SIZE,
      displayPeriod: detAvgMs,
      // Rendering
      renderW: getW(),
      renderH: getH(),
      fov: getFov(),
      fogDist: getFogDist(),
      gpuInfo: getGPUInfo(),
      wallsCount: WALLS_COUNT,
      maxSegments: MAX_SEGMENTS,
      textureCount: TEXTURES.length,
      worldW: WORLD_W,
      worldH: WORLD_H,
      // Network
      netConnected: isConnected(),
      selfId: getSelfId(),
      peerCount: getPeers().size,
      // Verbose breakdown (mode 2 only)
      timings,
    };

    t0 = performance.now();
    const lookAt = castCenterRay(player);
    drawDebugOverlay(player, fps, debugData, lookAt);
    _record('debug', performance.now() - t0);
  }
}

// ── Engine loop ──────────────────────────────────────────────────
let _prevTs = 0;   // rAF timestamp of the previous frame

function engine(ts) {
  if (_paused) return;

  // dt — time since the last frame in seconds.
  // Clamped to 100 ms (≈ 10 fps floor) so a tab returning from
  // background doesn't teleport the player through walls.
  // rafIntervalMs is the raw unclamped delta — recorded before the
  // clamp so the HUD can show true scheduler jitter independently
  // of what the physics simulation actually consumed.
  const rawInterval = _prevTs === 0 ? 1000 / 60 : ts - _prevTs;
  const dt = _prevTs === 0 ? 1 / 60 : Math.min(rawInterval / 1000, 0.1);
  _prevTs = ts;
  _record('rafInterval', rawInterval);

  // frameStart is captured before any work so frameMs reflects the
  // full cost of one tick — update + network + render + hud — as
  // seen by the browser's rAF scheduler.
  const frameStart = performance.now();

  frames++;
  if (ts - lastFpsTime >= 1000) {
    fps = frames;
    frames = 0;
    lastFpsTime = ts;
  }

  // player.update — CPU timed
  const t0 = performance.now();
  player.update(dt);
  _record('update', performance.now() - t0);

  // ── Network send ─────────────────────────────────────────────
  // Must come AFTER player.update() so the server receives the
  // committed post-physics position, and BEFORE render() so the
  // frame cost includes the emit overhead in frameMs.
  // Throttling (20 Hz) and dead-zone filtering live in network.js.
  sendMove(player.pos.x, player.pos.y, player.angle);

  render();

  // Record total frame cost after render() — includes update,
  // network send, castRays submission, minimap, and debug draw.
  _record('frameMs', performance.now() - frameStart);

  // Advance CPU ring index after all CPU slots are written.
  _ringIdx = (_ringIdx + 1) % RING_SIZE;

  requestAnimationFrame(engine);
}

// The engine loop is started by start(), called from the Play button.
// It does not fire automatically — the start menu must be dismissed first.

