/**
 * @file settings.js
 * @description Programmatic definition of all game settings using the UI API.
 */

(function () {
  'use strict';

  const UI = window.UI;
  if (!UI) return;

  // ── SVGs ──────────────────────────────────────────────────────────────
  const ICONS = {
    game: `<svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="7" /><polyline points="9,5 9,9 12,12" /></svg>`,
    camera: `<svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="10" rx="2" /><circle cx="9" cy="10" r="3" /><path d="M6 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1-1v1" /></svg>`,
    display: `<svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="14" height="10" rx="2" /><line x1="6" y1="15" x2="12" y2="15" /><line x1="9" y1="13" x2="9" y2="15" /></svg>`,
    controls: `<svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="10" rx="3" /><circle cx="6" cy="10" r="1.2" fill="currentColor" stroke="none" /><line x1="12" y1="8" x2="12" y2="10" /><line x1="11" y1="9" x2="13" y2="9" /></svg>`,
    audio: `<svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polygon points="3,6 8,6 12,3 12,15 8,12 3,12" /><path d="M14.5 6.5a4 4 0 0 1 0 5" /></svg>`,
    player: `<svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="3" /><path d="M3 16c0-3.314 2.686-6 6-6s6 2.686 6 6" /></svg>`,
  };

  // ── GAME ────────────────────────────────────────────────────────────
  UI.section('Game', ICONS.game, 'game', () => {
    UI.toggle('Show Minimap', 'minimap', {
      default: true,
      hint: 'Always visible during gameplay',
      onChange: v => window.__raycaster?.setMinimapVisible(v),
    });

    // DUMMY: no JS binding — toggle state is not read anywhere
    UI.toggle('Head Bobbing (dummy)', 'bobbing', {
      default: true,
      group: 'cameraMotion',
      hint: 'Camera sway while moving'
    });

    // DUMMY: no JS binding — toggle state is not read anywhere
    UI.toggle('Crosshair (dummy)', 'crosshair', {
      default: false,
      hint: 'Center-screen reticle'
    });

    // DUMMY: slider value is displayed but not passed to any engine system
    UI.slider('Movement Speed (dummy)', 'speed', {
      min: 1, max: 10, default: 5
    });

    // DUMMY: slider value is displayed but not passed to any engine system
    UI.slider('Interaction Range (dummy)', 'range', {
      min: 1, max: 8, default: 3
    });

    // DEV: visible only when IS_DEV build flag is true (ui.js).
    // Gating this row hides all dev-tool descendants automatically
    // via the SettingsManager requires chain.
    UI.toggle('Dev Mode', 'devMode', {
      default: false,
      flagGate: 'IS_DEV',
      hint: 'Enable developer tools and overlays',
      whenAbsent: 'hide',
    });
  });

  // ── CAMERA ──────────────────────────────────────────────────────────
  UI.section('Camera', ICONS.camera, 'camera', () => {
    UI.slider('Field of View', 'fov', {
      min: 45, max: 110, default: 60,
      format: v => v + '°',
      onChange: v => window.__raycaster?.setFov(v)
    });

    UI.slider('Look Sensitivity', 'sens', {
      min: 1, max: 20, default: Number(localStorage.getItem('cfg-look-sensitivity') ?? 10),
      onChange: v => {
        const normalized = v / 10;
        window.__raycaster?.setLookSensitivity(normalized);
        window.__input?.setLookSensitivity(normalized);
        localStorage.setItem('cfg-look-sensitivity', v);
      }
    });

    // DUMMY: no JS binding — toggle state is not read anywhere
    UI.toggle('Invert Y-Axis (dummy)', 'invertY', {
      default: false,
      hint: 'Flip vertical look direction'
    });

    // DUMMY: no JS binding — toggle state is not read anywhere
    UI.toggle('Smooth Camera (dummy)', 'smooth', {
      default: true,
      group: 'cameraMotion',
      hint: 'Interpolate camera rotation'
    });

    // DUMMY: slider value is displayed but not passed to any engine system
    UI.slider('Near Clip Distance (dummy)', 'clip', {
      min: 1, max: 10, default: 1,
      format: v => (v / 10).toFixed(1)
    });
  });

  // ── DISPLAY ─────────────────────────────────────────────────────────
  UI.section('Display', ICONS.display, 'display', () => {
    UI.toggle('Debug Info', 'debug', {
      default: false,
      requires: 'devMode',
      whenAbsent: 'hide',
      hint: 'Show position, velocity & angle',
      onChange: v => window.__raycaster?.setDebug(v)
    });

    UI.toggle('Performance Overlay', 'perf', {
      default: false,
      requires: 'debug',
      whenAbsent: 'disable',
      hint: 'Requires Debug Info to be on',
      onChange: v => window.__raycaster?.setPerf(v)
    });

    UI.slider('Fog Distance', 'fogDist', {
      min: 1, max: 30, default: 12,
      onChange: v => window.__raycaster?.setFogDist(v)
    });

    // Resolution logic will need to be wired back to the dropdown helper
    UI.dropdown('Render Resolution', 'res');

    // DUMMY: slider value is displayed but not passed to any engine system
    UI.slider('Brightness (dummy)', 'bright', {
      min: 1, max: 10, default: 7
    });
  });

  // ── CONTROLS ────────────────────────────────────────────────────────
  UI.section('Controls', ICONS.controls, 'controls', () => {
    UI.toggle('Touch Controls', 'touch', {
      default: window.__input?.isTouch() ?? true,
      hint: 'On-screen WASD pad',
      onChange: v => window.__input?.setWasdPadVisible(v)
    });

    UI.toggle('Pointer Lock', 'pointerLock', {
      default: true,
      hint: 'Lock cursor for mouse look',
      onChange: v => window.__input?.setPointerLockEnabled(v)
    });
  });

  // ── AUDIO ───────────────────────────────────────────────────────────
  UI.section('Audio', ICONS.audio, 'audio', () => {
    // DUMMY: no JS binding — toggle state is not read anywhere
    UI.toggle('Master Audio (dummy)', 'masterAudio', {
      default: true,
      hint: 'Enable all sound output'
    });

    // DUMMY: slider value is displayed but not passed to any engine system
    UI.slider('Master Volume (dummy)', 'masterVol', {
      min: 0, max: 10, default: 8
    });

    // DUMMY: slider value is displayed but not passed to any engine system
    UI.slider('Music Volume (dummy)', 'musicVol', {
      min: 0, max: 10, default: 5
    });

    // DUMMY: slider value is displayed but not passed to any engine system
    UI.slider('SFX Volume (dummy)', 'sfxVol', {
      min: 0, max: 10, default: 7
    });

    // DUMMY: no JS binding — toggle state is not read anywhere
    UI.toggle('Spatial Audio (dummy)', 'spatial', {
      default: true,
      hint: '3D positional sound'
    });
  });

  // ── PLAYER (Dev Only) ───────────────────────────────────────────────
  UI.section('Player Stats', ICONS.player, 'player', { requires: 'devMode', whenAbsent: 'hide' }, () => {
    UI.slider('Max Speed', 'player-maxspeed', {
      min: 0.05, max: 0.50, step: 0.01, default: 0.25,
      requires: 'devMode', whenAbsent: 'hide'
    });
    UI.slider('Acceleration', 'player-accel', {
      min: 0.01, max: 0.15, step: 0.01, default: 0.04,
      requires: 'devMode', whenAbsent: 'hide'
    });
    UI.slider('Resistance', 'player-friction', {
      min: 0.50, max: 0.99, step: 0.01, default: 0.82,
      requires: 'devMode', whenAbsent: 'hide'
    });
    UI.slider('Slide Threshold', 'player-slide', {
      min: 0.05, max: 0.80, step: 0.05, default: 0.25,
      requires: 'devMode', whenAbsent: 'hide'
    });
  });

})();
