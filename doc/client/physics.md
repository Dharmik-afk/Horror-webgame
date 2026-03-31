# Physics and Collision

Player updating logic (`player.js`) includes sophisticated iteration systems for wall collision and momentum simulation.

## Veret Integration

The physical simulation uses a form of Verlet half-step integration:
- `dt` is dynamically fetched per-frame based on exact RAF cadence up to `100ms` clamps. Sub-stepping occurs when momentum is high (like a collision) to prevent the player from vaulting over geometry.
- Acceleration is layered onto velocity first, followed by friction damping `FRICTION_60`.

## Swept Crossing & Push-Out Simulation

Collision resolution requires up to 3 iterations per loop frame to prevent getting stuck in tight corners (sliding alongside walls).

### Swept Crossing Guards

The system first creates infinite lines spanning each wall and solves distance to wall algebraically (`dOld`, `dNew`).
If a player's distance crosses zero (crossing the line segment bounded in `0..1` parametric span), they are explicitly positioned backed out perfectly tangential at Distance $R$.

### Normal Push-out & Slide Compensation

Segments project out based on an explicit overlap radius ($R$). 
Because a purely perpendicular projection will let players grind against extremely tight angled corners indefinitely, the collision tests use **Grazing Angle Suppression**.

**Slide Suppression Threshold**:
If the entry angle approaches pure perpendicular, the entirety of orthogonal momentum is halted. 
If approaching at a grazing angle (slideRatio > 0.25 ≈ 75° threshold), orthogonal momentum is retained and normal vector momentum is rejected. This prevents bouncing while feeling very smooth.
