# Wire Protocol Reference

Complete reference for the JSON wire protocol between the raycaster client (`network.js`) and the game server (`internal/gameserver/`). All messages are UTF-8 JSON text frames over WebSocket.

## Connection

- **Endpoint**: `ws://host:9000/ws`
- **Transport**: WebSocket (RFC 6455) via HTTP upgrade
- **Framing**: Text frames only — no binary
- **Max message size**: 512 bytes (server-enforced read limit)

## Message Types

### Server → Client

| Type | When Sent | Fields |
|------|-----------|--------|
| `init` | Once, immediately after connection | `type`, `id`, `players` |
| `state` | After every peer `move` | `type`, `players`, `npcs` |
| `leave` | When a peer disconnects | `type`, `id` |

### Client → Server

| Type | When Sent | Fields |
|------|-----------|--------|
| `move` | On player position change (throttled 20 Hz) | `type`, `x`, `y`, `angle` |

## Field Types

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Message discriminator: `"init"`, `"state"`, `"leave"`, or `"move"` |
| `id` | `string` | 16-character hex string (e.g. `"a1b2c3d4e5f6g7h8"`) |
| `x` | `float64` | World-space X coordinate |
| `y` | `float64` | World-space Y coordinate |
| `angle` | `float64` | Facing angle in radians |
| `players` (init) | `map<string, {x,y,angle}>` | Keyed by peer ID — excludes self |
| `players` (state) | `array<{id,x,y,angle}>` | Array of peer entries — excludes recipient |
| `npcs` | `array` | Always `[]` — reserved for Phase 2 NPC system |

## Sequence Diagram

```
Client A                     Server                     Client B
   │                           │                           │
   │── HTTP Upgrade ──────────►│                           │
   │◄── 101 Switching ────────│                           │
   │◄── init {id:"A", ────────│                           │
   │      players:{B:{...}}}   │                           │
   │                           │                           │
   │── move {x,y,angle} ─────►│                           │
   │                           │── state {players:[A]} ──►│
   │                           │                           │
   │                           │◄── move {x,y,angle} ─────│
   │◄── state {players:[B]} ──│                           │
   │                           │                           │
   │                           │   (Client B disconnects)  │
   │◄── leave {id:"B"} ───────│                           │
   │                           │                           │
```

## Client-Side Throttling

The client (`network.js`) applies two layers of output filtering before sending `move` messages:

1. **Rate Throttle**: Maximum 20 Hz (one message per 50 ms)
2. **Dead-Zone Epsilon**: A move is only sent if position or angle changed beyond the epsilon threshold:
   - `POSITION_EPSILON` — minimum positional delta
   - `ANGLE_EPSILON` — minimum angular delta

If the player is idle and no move has been sent for an extended period, `sendIdle()` pushes a keep-alive message to prevent the server's 60-second read timeout from closing the connection.

## Timeout Behaviour

| Timeout | Value | Effect |
|---------|-------|--------|
| Server read deadline | 60 s | Connection closed if no message or pong received |
| Server write deadline | 10 s | Write abandoned if send stalls |
| Server shutdown grace | 10 s | In-flight handlers allowed to complete |
| Client reconnect | Exponential backoff | Up to 5 retries on connection failure |
