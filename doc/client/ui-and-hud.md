# UI, CSS and Environment Interfaces

The client handles interactive DOM logic and canvas UI separately. It implements a fully normalized separation of CSS, component behavior, and rendering sizes. 

## `ui.js` - Settings Manager

Operating isolated out of module scopes in standard script context, `SettingsManager` builds UI bindings. Its primary concept dictates that **DOM acts as visual output, never factual source truth**:
- Dependencies (`requires`), defaults, and exclusions (`mutuallyExclusive`) are strictly built via `SETTINGS_CONFIG` dictionary trees rather than nested Event listeners.
- **Cascading State Tree**: Handlers propagate states like disabled/hidden rows dynamically downwards. If `devMode()` defaults to false based on a build constant (`flagGate`), descendants such as Debug overlay and Timing metrics inherit the `hidden` class universally.
- Setting elements map back functionally to `<input class="cfg-*">` namespacing structures inside the DOM.

## Input Interceptor

The global Input processor maps keyboard (WASD) and DOM touches efficiently into movement and lookup degrees seamlessly.
1. Mobile devices process generic layout Touches mapped mathematically into `player.lookDeltaX`.
2. Desktops prefer capturing directly through typical Web API `ProxyLock`. Drag and hold fallbacks provide functional guarantees where ProxyLock refuses integration.
- Keyboard bindings trigger through extremely lightweight Pub/Sub messaging to `player.js` so hardware events aren't delayed resolving physics.

## HUD Canvas Overlays

- Renders 2D content perfectly aligned relative to window limits (resilient to fullscreen or internal WebGL resolution adjustments mapping to DOM constraints).
- The components like Minimaps clear explicitly using bounds-rect offsets before updating regions. Full context clears don't trigger per frame protecting low-end processing margins.
