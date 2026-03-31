# Network System

The client relay is contained in `network.js`. It utilizes native browser WebSockets and operates as a pure transport relay in Phase 1 without enforcing game-state rule checking locally. It operates completely independently from ES modules like `player.js` directly, taking inputs directly from main loops.

## Player Identity (Cookie-Based)

The file server (`:8000`) assigns a persistent `player_id` cookie on first page load via `IdentityMiddleware`. The cookie:
- Is a 16-hex-char cryptographically random ID (same format as gameserver IDs).
- Scoped to `Path=/` so browsers send it to both `:8000` and `:9000` (cookies scope by domain, not port).
- Has a 24-hour `Max-Age`; persists across page reloads and browser restarts within that window.
- Is `HttpOnly=false` so it can be inspected/cleared in DevTools for testing.

The game server reads this cookie during the WebSocket upgrade handshake and uses it as the player's ID. This means:
- Refreshing the page reconnects with the **same** player ID.
- Each incognito window / browser profile gets a unique ID (for multi-player testing on one machine).
- If a stale connection with the same ID exists, the game server evicts it before registering the new one.

## Connection Protocol

1. The client derives the game server URL dynamically from `window.location.hostname`:
   - Local dev: page at `localhost:8000` → connects to `ws://localhost:9000/ws`
   - LAN test: page at `192.168.x.x:8000` → connects to `ws://192.168.x.x:9000/ws`
2. The WebSocket upgrade request carries the `player_id` cookie automatically.
3. Retries are attempted over an exponential back-off up to 5 times.
4. Once connected, it awaits a `self:init` broadcast from the server.
   
## Live Broadcast State

The client handles incoming JSON objects over standard message bus logic, injecting directly into an external peers memory address:
- `type: 'init'`: Allocates local UUID (`id`), populating early active peers mapped to state.
- `type: 'state'`: Handles raw X, Y, Angle values. Iteratively matches arrays.
- `type: 'leave'`: Drops Peer UUID matching.
The `_peers` map acts as a unified singleton accessed safely globally through `getPeers()`.

## Position Transport Rules

Inbound connections are pushed directly on reception. Fast outgoing connections limit broadcast load via strict thresholds evaluated against delta dead-zones. 

### Output Limitations
- **Throttling Interval**: Emits locked effectively at `20Hz` (`50ms`).
- **Precision Epsilon Constraints**: The player state needs to differ meaningfully (`POSITION_EPSILON` or `ANGLE_EPSILON`) for an update to warrant being queued.
- **Keep-Alive (Idle)**: Should the engine rest on unchanged coordinates repeatedly due to epsilon dead-zones, `sendIdel()` pushes a `{ "type": "Idel" }` ping, ensuring connection keep-alive timeout limits are not rejected.
