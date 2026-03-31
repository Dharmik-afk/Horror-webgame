# Rendering Pipeline

The 3D view is completely rendered by a single pipeline on WebGL2 to achieve high performance with a "Doom-style" view. 

## Fragment Shader Raycasting

All walls are projected by sending rays out corresponding to screen pixels. Rather than casting rays step-by-step through a grid (DDA), the engine uses analytic geometry:
- It uses **Cramér's rule** for branch-free ray-segment intersection.
- The iteration limit loop size matches `MAX_SEGMENTS`. All execution lanes hit the break condition together using `u_segmentCount`, preventing warp divergence.

## Geometry Packing (`RGBA32F` Texture)

Since the engine executes mathematically on segments (not grids), all world geometry arrays (`map.js`) are serialized and passed to the shader in a packed floating-point texture:
- **Texel 0 (Geometry)**: `[start X, start Y, delta X, delta Y]`
- **Texel 1 (Appearance)**: `[absNY, R, G, B]`
- **Texel 2 (Material)**: `[texId, brightness, _, _]`

To minimize memory accesses within the loop, the shader loop *only checks Texel 0* to compute intersection. If the segment is the closest hit, it defers fetching Texel 1 and 2 until after the loop.

## GPU Profiling (Timer Queries)

The rendering system features two GPU load timing paths to avoid stalling the CPU or freezing the game:
1. **Path A (Timer Ext: `EXT_disjoint_timer_query_webgl2`)**
   Wraps the `drawArrays` call in a non-blocking asynchronous WebGLQuery. The CPU polls it the next frame, maintaining the frame rate without IPC overhead pipeline stalls.
2. **Path B (`gl.finish()` Fallback)**
   When debug mode is verbose and browsers lack the timer query extension, it falls back to hardware fenced synchronous `gl.finish()`. Even when stalled, this is cordoned off before HUD components draw so timing graphs remain accurate.
