### Sprite System Upgrade Plan: Doom-Style Directional Sprites

## 1. Objective

Implement a multi-directional, animated sprite system for entities (players/NPCs)
using the standard "Doom" naming convention (8-way rotations + mirroring).

## 2. Technical Analysis

- **Naming Convention:** `[PREFIX][FRAME][ROTATION][MIRROR_FRAME][MIRROR_ROTATION]`
    (e.g., `FSZPA2A8` means Frame A, Rot 2 and Rot 8 mirrored).
- **GPU Requirement:** `TEXTURE_2D_ARRAY` is required to store multiple frames/rotations in a single bind point.
- **Occlusion:** Maintain existing distance-buffer testing in the fragment shader.

## 3. Resource Folder Structure

| Directory                       | Purpose            | Key Content / Patterns           |
| :------------------------------ | :----------------- | :------------------------------- |
| **`public/resource/data/`**     | Metadata & Scripts | `.txt` (ignore for now).     |
| **`public/resource/sprites/`**  | **Entity Visuals** | `enemies/` and `weapons/`.       |
| ↳ `enemies/[type]/[variant]/`   | NPC Frames         | e.g., `zombiescientist/pistol/`. |
| **`public/resource/textures/`** | World Geometry     | `walls/`, `flats/`, `sky/`.      |

## 4. Sprite Naming Convention (Doom Standard)

Sprites in `zombiescientist/pistol/` follow this logic:

- **`FSZP`**: Sprite Prefix.
- **`A` to `V`**: Animation Frame (e.g., `A` = Walking Start).
- **`1` to `8`**: Rotation Index:
  - `1`: Facing **Front** (at player).
  - `2`: Front-Left (45°).
  - `3`: Side-Left (90°).
  - `4`: Back-Left (135°).
  - `5`: Facing **Back** (away from player).
- **Mirrored Entries**: `FSZPA2A8.png` is used for **Rotation 2** and mirrored horizontally for **Rotation 8**.

## 5. Implementation Phases

### Phase 1: Sprite Registry & Loader (`sprite_loader.js`)

- **Task:** Create a system to batch-load sprites into a uniform `TEXTURE_2D_ARRAY`.
- **Strategy:**
  - Identify a standard sprite size (e.g., 128x128).
  - Draw each sprite onto a centered-bottom canvas before uploading to GL.
  - Build a lookup table: `(prefix, frame, rotation) -> { layer, mirrored }`.

### Phase 2: Shader & Renderer Upgrade (`sprite_renderer.js`)

- **Task:** Upgrade shaders to support texture arrays and horizontal flipping.
- **Vertex Shader:**
  - New Uniforms: `u_texIndex`, `u_mirror`.
  - UV Logic: `v_uv.x = mix(uv.x, 1.0 - uv.x, u_mirror)`.
- **Fragment Shader:**
  - Change sampler to `sampler2DArray`.

### Phase 3: Entity Logic (`entity.js`)

- **Task:** Update `Entity` to track animation state and calculate viewing angles.
- **Fields:** `state`, `frame`, `spritePrefix`, `animTimer`.
- **Method `getSpriteInfo(observer)`**:
  - Calculates relative angle: `(entity.angle - angleToObserver + PI) % (2PI)`.
  - Maps angle to 8-way rotation index (1=Front, 5=Back).
  - Returns `{ layer, mirrored }` from the registry.

### Phase 4: Integration (`main.js`)

- **Task:** Hook it all together.
- Load the `zombiescientist/pistol` assets at startup.
- Update `render()` to pass calculated sprite info to `drawSprites()`.

## 6. Risks & Mitigations

- **Memory:** `TEXTURE_2D_ARRAY` can be large. _Mitigation:_ Use 128x128 resolution for sprites.
- **Coordinate Systems:** Angle conventions must be identical between CPU and GPU. _Mitigation:_ Use consistent `Atan2(dx, -dy)` for North=0.
