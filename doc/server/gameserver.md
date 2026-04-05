# Game Server

The WebSocket game server lives in `internal/gameserver/` and provides real-time multiplayer relay for the raycaster engine. It uses `gorilla/websocket` for WebSocket handling and Go's `net/http` standard library for the HTTP layer — no framework required.

## Endpoints

| Protocol | Path | Port | Purpose |
|----------|------|------|---------|
| WebSocket | `/ws` | 9000 | Multiplayer relay — player state synchronisation |
| HTTP GET | `/health` | 9000 | Health check — returns `{"status":"ok","players":N}` |

## CLI Usage

```
raycaster dev
raycaster game
```

The `dev` command starts both servers with prefixed logs. The `game` command starts only the game server. The port is hardcoded to `9000`.

## Wire Protocol (JSON over WebSocket)

All messages are JSON-encoded text frames.

### Server → Client

#### `init`
Sent once immediately after connection. Contains the client's assigned ID and a snapshot of all currently connected peers (excluding self).

```json
{
  "type": "init",
  "id": "a1b2c3d4e5f6g7h8",
  "players": {
    "peer_id_1": { "x": 3.5, "y": 2.0, "angle": 1.57 },
    "peer_id_2": { "x": 7.0, "y": 4.5, "angle": 0.00 }
  }
}
```

#### `state`
Broadcast to all clients **except the sender** after every `move` message is processed. Contains the full player list (excluding the recipient) and an `npcs` array (always empty — Phase 2 placeholder).

```json
{
  "type": "state",
  "players": [
    { "id": "peer_id", "x": 3.5, "y": 2.0, "angle": 1.57 }
  ],
  "npcs": []
}
```

#### `leave`
Broadcast to all remaining clients when a peer disconnects.

```json
{
  "type": "leave",
  "id": "disconnected_peer_id"
}
```

### Client → Server

#### `move`
Position update from the client. The client throttles these to 20 Hz with dead-zone filtering — the server trusts and relays them as-is.

```json
{
  "type": "move",
  "x": 3.5,
  "y": 2.0,
  "angle": 1.57
}
```

Unknown message types are silently ignored.

## Connection Lifecycle

1. Client connects to `ws://host:9000/ws`. The `CheckOrigin` upgrader accepts all origins (suitable for local dev).
2. Server generates a 16-character hex ID via `crypto/rand` and registers the client in the `Registry`.
3. Server sends an `init` message with the new ID and a snapshot of all other players.
4. Two goroutines are spawned per client:
   - **Writer goroutine** — drains the client's `send` channel and writes to the WebSocket. Write deadline: 10 seconds.
   - **Reader goroutine** — reads incoming messages, updates state, and triggers broadcasts. Read deadline: 60 seconds, refreshed on every message and pong.
5. On disconnect (read error or close frame), the reader goroutine cleans up: closes the send channel (signalling the writer to exit), removes the client from the registry, and broadcasts a `leave` message.

## Registry

The `Registry` (`registry.go`) is a thread-safe in-memory store using `sync.RWMutex`:

| Method | Lock Type | Purpose |
|--------|-----------|---------|
| `add` | Write | Register a new client and initialise its state |
| `remove` | Write | Delete a client and its state |
| `setState` | Write | Update a client's position |
| `snapshot` | Read | Copy all states excluding one ID |
| `broadcast` | Read | Send a message to all clients except one |
| `sendTo` | Read | Send a message to a specific client |
| `count` | Read | Return the number of connected clients |

### Backpressure

Each client has a buffered send channel (capacity: 64). If the channel is full (slow consumer), the message is **dropped** with a log warning rather than blocking the broadcaster. This prevents one slow client from stalling the entire server.

## Concurrency Model

```
                ┌──────────────┐
 HTTP Upgrade → │  wsHandler   │ ─── spawns per client ──┐
                └──────────────┘                         │
                                              ┌──────────┴──────────┐
                                              │                     │
                                         readerLoop            writerLoop
                                         (reads ws,            (drains send
                                          updates              channel,
                                          registry,            writes ws)
                                          broadcasts)
                                              │                     │
                                              └─── send channel ────┘
                                                   ([]byte, cap 64)
```

All registry mutations go through the mutex. Broadcasts iterate the client map under a read lock and push to buffered channels without blocking.

## Graceful Shutdown

On `SIGINT`/`SIGTERM`, the server calls `http.Server.Shutdown()` with a 10-second context deadline. This stops accepting new connections and waits for existing handlers to complete. Logging is handled via the package-level `Logger`, allowing for prefixing in `dev` mode.
