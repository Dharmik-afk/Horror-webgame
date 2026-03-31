import { gl } from './canvas.js';
import { getDistTex, getFbo } from './renderer.js';

// ── Sprite Shader Source ──────────────────────────────────────────
const VS_SRC = /* glsl */`#version 300 es
layout(location = 0) in vec2 a_quadPos; // [-0.5, 0] to [0.5, 1]

uniform vec2  u_playerPos;
uniform vec2  u_dir;
uniform vec2  u_plane;
uniform vec2  u_spritePos;
uniform vec2  u_spriteSize;
uniform float u_H;

out vec2  v_uv;
out float v_dist;
out float v_screenX; // Normalized Screen X for depth buffer sampling

void main() {
    // 1. Transform sprite to camera-relative space
    vec2 relPos = u_spritePos - u_playerPos;
    
    // Rotation matrix from world to camera space
    // dir is (sinA, -cosA), so plane is (cosA, sinA) * fovHalfTan
    // We can use u_dir and u_plane directly.
    float invDet = 1.0 / (u_plane.x * u_dir.y - u_dir.x * u_plane.y);
    float camX = invDet * (u_dir.y * relPos.x - u_dir.x * relPos.y);
    float camY = invDet * (-u_plane.y * relPos.x + u_plane.x * relPos.y);
    
    v_dist = camY;
    v_uv = vec2(a_quadPos.x + 0.5, 1.0 - a_quadPos.y);
    
    // 2. Project to screen
    float spriteScreenX = camX / camY;
    v_screenX = (spriteScreenX + 1.0) * 0.5;
    
    float lineHeight = u_H / camY;
    float xOffset = a_quadPos.x * u_spriteSize.x * (u_H / camY);
    float yOffset = (a_quadPos.y - 0.5) * u_spriteSize.y * (u_H / camY);

    // Final NDC position
    // a_quadPos.x is [-0.5, 0.5], u_spriteSize.x is width in world units/tiles
    // But in raycasting, width is usually relative to distance.
    // Standard billboard: 
    gl_Position = vec4(
        spriteScreenX + (a_quadPos.x * u_spriteSize.x / camY),
        (a_quadPos.y * 2.0 - 1.0) * (u_spriteSize.y / camY),
        0.0, 
        1.0
    );
}`;

const FS_SRC = /* glsl */`#version 300 es
precision highp float;

uniform sampler2D u_spriteTex;
uniform sampler2D u_distBuffer;
uniform vec2      u_res;        // Viewport resolution for gl_FragCoord mapping
uniform float     u_fogDist;

in vec2  v_uv;
in float v_dist;
in float v_screenX;

out vec4 fragColor;

void main() {
    // 1. Depth test against environment
    // Use gl_FragCoord to sample the distance buffer at EXACTLY this pixel.
    vec2  screenUV = gl_FragCoord.xy / u_res;
    vec4  p        = texture(u_distBuffer, screenUV);
    float wallDist = p.r * 255.0 + p.g + p.b / 255.0;
    
    // Bias of 0.01 prevents z-fighting at the exact wall surface.
    if (v_dist > wallDist + 0.01) discard;
    if (v_dist <= 0.1) discard; // Near plane clipping

    // 2. Sample sprite texture
    vec4 texCol = texture(u_spriteTex, v_uv);
    if (texCol.a < 0.5) discard;

    // 3. Simple distance fog
    float fog = clamp(v_dist / u_fogDist, 0.0, 1.0);
    vec3 finalCol = mix(texCol.rgb, vec3(0.0), fog * 0.85);

    fragColor = vec4(finalCol, texCol.a);
}
`;

let _program;
let _vao;
let _uPlayerPos, _uDir, _uPlane, _uSpritePos, _uSpriteSize, _uH, _uFogDist, _uRes;
let _spriteTex;

function _compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(`[sprite_renderer.js] Shader compile error: ${gl.getShaderInfoLog(s)}`);
    }
    return s;
}

export function initSpriteRenderer() {
    const vs = _compileShader(gl.VERTEX_SHADER, VS_SRC);
    const fs = _compileShader(gl.FRAGMENT_SHADER, FS_SRC);
    _program = gl.createProgram();
    gl.attachShader(_program, vs);
    gl.attachShader(_program, fs);
    gl.linkProgram(_program);

    _vao = gl.createVertexArray();
    gl.bindVertexArray(_vao);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // Quad vertices: x, y in range [-0.5, 0.5] for x, [0, 1] for y
    const verts = new Float32Array([
        -0.5, 0.0,
        0.5, 0.0,
        -0.5, 1.0,
        0.5, 1.0
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    _uPlayerPos = gl.getUniformLocation(_program, 'u_playerPos');
    _uDir = gl.getUniformLocation(_program, 'u_dir');
    _uPlane = gl.getUniformLocation(_program, 'u_plane');
    _uSpritePos = gl.getUniformLocation(_program, 'u_spritePos');
    _uSpriteSize = gl.getUniformLocation(_program, 'u_spriteSize');
    _uH = gl.getUniformLocation(_program, 'u_H');
    _uRes = gl.getUniformLocation(_program, 'u_res');
    _uFogDist = gl.getUniformLocation(_program, 'u_fogDist');

    gl.useProgram(_program);
    gl.uniform1i(gl.getUniformLocation(_program, 'u_spriteTex'), 0);
    gl.uniform1i(gl.getUniformLocation(_program, 'u_distBuffer'), 1);
}

export async function loadSpriteAtlas(path) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            _spriteTex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, _spriteTex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.bindTexture(gl.TEXTURE_2D, null);
            resolve();
        };
        img.onerror = reject;
        img.src = path;
    });
}

/**
 * Renders a list of entities.
 * @param {Player} player 
 * @param {Entity[]} entities 
 * @param {number} fogDist
 */
export function drawSprites(player, entities, fogDist) {
    if (!entities.length) return;

    gl.useProgram(_program);
    gl.bindVertexArray(_vao);

    // Environment uniforms
    gl.uniform2f(_uPlayerPos, player.pos.x, player.pos.y);
    gl.uniform2f(_uDir, player.sinA, -player.cosA);
    const fovHalfTan = Math.tan((60 / 2) * Math.PI / 180); // FIXME: get from renderer
    gl.uniform2f(_uPlane, player.cosA * fovHalfTan, player.sinA * fovHalfTan);
    gl.uniform1f(_uH, gl.drawingBufferHeight);
    gl.uniform1f(_uFogDist, fogDist);

    // Textures
    gl.uniform2f(_uRes, gl.drawingBufferWidth, gl.drawingBufferHeight);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _spriteTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, getDistTex());

    // 1. Break the Feedback Loop
    // We are sampling from getDistTex() while it is attached to the FBO.
    // We must detach it from the FB before we can safely sample from it.
    gl.bindFramebuffer(gl.FRAMEBUFFER, getFbo());
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]); // Only draw to color

    // 2. Draw active sprites
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    for (const ent of entities) {
        gl.uniform2f(_uSpritePos, ent.pos.x, ent.pos.y);
        gl.uniform2f(_uSpriteSize, 1.0, 1.0); // Tiles wide/high
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.disable(gl.BLEND);

    // 3. Restore the state for the next frame
    // Unbind from the texture unit to prevent feedback loops in the next environment pass
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Re-attach the distance texture so the environment pass can write to it.
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, getDistTex(), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
