# Client Architecture Overview

The client is a vanilla JavaScript 2.5D raycasting engine optimized for WebGL2. It uses no bundlers and no frameworks relying natively on ES modules and standard browser APIs.

## Core Architectural Pillars

1. **Strict CPU / GPU Split**
   The CPU (`main.js`, `player.js`, `map.js`) runs physics, UI logic, and game state updates. The GPU (`renderer.js` fragment shader) processes the entire 3D raycasting workload. The CPU does not iterate pixels or columns.
2. **Dual-Canvas Rendering**
   - **WebGL2 Canvas (`#c`)**: Renders the 3D raycaster view. Render resolution is scalable and decoupled from the physical display dimension.
   - **2D HUD Canvas (`_hud`)**: Renders 2D overlays (crosshair, minimap, debug text). Overlays clear only dirty sub-regions per frame and track actual CSS dimensions to avoid enormous pixel processing loops on 4K displays.
3. **Component Modularity**
   All core systems are fully decoupled ESM modules:
   - `main.js`: Main RAF loop, sets global contexts.
   - `canvas.js`: Singleton exposing WebGL and HUD contexts and dimension getters.
   - `renderer.js`: Shaders and GL draw pipelines.
   - `player.js`: Entity inheritance, player state, collision physics.
   - `network.js`: WebSocket transport client.
   - `hud.js`: Debug overlay arrays and HUD logic.
   - `map.js`: Geometric data pipeline and Texture atlas generator.
4. **Deferred Global UI**
   `ui.js` is loaded directly via `<script>` *before* ES modules. It sets up settings listeners globally so interactive UI elements work immediately. It hooks to the engine via `window.__raycaster`.

## Render Loop Lifecycle

1. **`requestAnimationFrame`** loop executes in `main.js` `engine()`.
2. **`player.update(dt)`**: Moves the player, performs collision with iterations, and recalculates trig cache (`sinA`, `cosA`).
3. **`sendMove()`**: Syncs location safely via WebSocket (throttled).
4. **`render()`**:
   - Analyzes WebGL timer queries from the previous frame.
   - `castRays()`: Updates uniforms and issues a single procedural triangle vertex shader draw call for full-screen raycasting.
   - `drawCrosshair()` / `drawMinimap()` / `drawDebugOverlay()`: Invokes partial Canvas2D context updates for HUD.
