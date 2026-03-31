/**
 * @file ui.js
 * @description Non-module UI script — loaded via a plain <script> tag before
 *              main.js so the settings panel and HUD controls are interactive
 *              even before the WebGL engine initialises.
 *
 * ─── Architecture notes ─────────────────────────────────────────────────────
 *
 *  This file intentionally uses no ES-module syntax (no import/export).
 *  It runs in the global scope so that main.js (an ES module) can reach
 *  shared state through explicit window.* properties:
 *
 *    window._cfgPanel      { open(ctx), close() }   — settings panel API
 *    window._resDropdown   { selectValue, LABELS, list } — resolution sync
 *    window._showStart()   — called by main.js once autoDetect resolves
 *    window._onResDetected(value) — called by main.js to badge the chosen res
 *
 *  Engine calls go the other way through window.__raycaster, which is set by
 *  main.js after the WebGL context is ready.  All calls guard with optional
 *  chaining (window.__raycaster?.method()) so the UI never throws during the
 *  pre-engine phase.
 *
 * ─── Dynamic settings system (SettingsManager) ──────────────────────────────
 *
 *  Settings state is owned by a single SettingsManager object — the DOM is
 *  never the source of truth.  Constraint rules are declared in SETTINGS_CONFIG
 *  rather than scattered across individual event handlers:
 *
 *    requires          The setting is force-disabled and locked to OFF whenever
 *                      the named parent key is false.
 *                      Example: "perf" requires "debug".
 *
 *    whenAbsent        Controls what happens to the row when `requires` is unmet.
 *                      'disable' (default) — row stays visible but is dimmed and
 *                        non-interactive (.cfg-row-disabled).
 *                      'hide' — row is removed from layout entirely
 *                        (.cfg-row-hidden).
 *                      A child always inherits the most restrictive ancestor
 *                      mode: if any ancestor resolves to 'hide', the child is
 *                      also hidden even if its own whenAbsent is 'disable'.
 *
 *    mutuallyExclusive Named group — toggling a member ON automatically turns
 *                      every other member of the same group OFF.
 *                      Example: "bobbing" and "smooth" share group "cameraMotion".
 *
 *  DOM changes (checkbox state + .cfg-row-disabled / .cfg-row-hidden classes)
 *  are always derived from the state object via _syncDom(), never written
 *  ad-hoc.  Engine callbacks (window.__raycaster?.setDebug, etc.) are invoked
 *  after the state and DOM are already consistent.
 *
 * ─── Sections ───────────────────────────────────────────────────────────────
 *
 *  1. SettingsManager        — central state + constraint engine
 *  2. Fullscreen toggle      — fs-btn SVG icon swap + orientation lock
 *  3. Settings panel         — open/close, context (game vs start), parallax tilt
 *  4. Resolution dropdown    — custom listbox with recommended-badge sync
 *  5. Settings nav scroll    — left-nav highlight driven by scroll midpoint
 *  6. Slider value display   — live label updates for range inputs
 *  7. Start menu             — play/settings buttons, arrow-key roving focus,
 *                              parallax tilt, _showStart hook
 *  8. Resolution detected    — window._onResDetected badge injection
 *
 * ─── CSS modules touched ────────────────────────────────────────────────────
 *
 *  css/settings.css   — .cfg-row-disabled, .cfg-row-hidden (constraint UI)
 *  css/hud-buttons.css — #cfg-btn, #fs-btn
 *  css/fullscreen.css  — body.is-fullscreen overrides
 *  css/start-menu.css  — #start-overlay, .threeD-button-set
 */

/* ═══════════════════════════════════════════════════════════════════════════
   1. SETTINGS MANAGER
   ═══════════════════════════════════════════════════════════════════════════
   Owns all toggle/option state.  Constraint rules declared below are applied
   automatically whenever SettingsManager.set() is called.              */
(function () {

  // ── Build flag ─────────────────────────────────────────────────────────
  // Flip IS_DEV to true locally to expose the Dev Mode toggle in settings.
  // This is a deploy-time constant — it is never written at runtime.
  // When false, Dev Mode and all its descendants are fully hidden; the user
  // sees no trace of developer tooling.
  const IS_DEV = true;

  // Named flag registry — referenced by SETTINGS_CONFIG entries via flagGate.
  // Add future build flags here rather than scattering them as bare globals.
  const DEV_FLAGS = { IS_DEV };

  /**
   * Declarative configuration for every managed setting.
   *
   * Shape of each entry:
   * {
   *   id          : string            — id of the <input> element in the HTML
   *   default     : boolean           — initial checked state
   *   flagGate?   : string            — name of a key in DEV_FLAGS; if that
   *                                     flag is false the row is permanently
   *                                     hidden regardless of any other state.
   *                                     Evaluated once — flags are constants.
   *   requires?   : string            — key of another setting that must be ON
   *                                     for this setting to be available.
   *                                     Children depend on the toggle state,
   *                                     NOT on the parent's flagGate.
   *   whenAbsent? : 'disable'|'hide'  — what to do when requires is unmet.
   *                   'disable' (default) — row shown but dimmed, non-interactive.
   *                   'hide'              — row removed from layout entirely.
   *                 A child always inherits the most restrictive ancestor mode:
   *                 if any ancestor resolves to 'hide', the child is also hidden
   *                 even if its own whenAbsent is 'disable'.
   *   group?      : string            — mutual-exclusion group name; only one
   *                                     member of a group can be ON at a time
   *   onChange?   : fn                — engine callback fired after state + DOM
   *                                     are already consistent
   * }
   *
   * Add new settings here; do NOT add new constraint logic to event handlers.
   *
   * Planned additions (not yet implemented):
   *   bobbing  { group: 'cameraMotion' }  — mutually exclusive with smooth
   *   smooth   { group: 'cameraMotion' }
   */
  const SETTINGS_CONFIG = {
    // ── Minimap ────────────────────────────────────────────────────────
    minimap: {
      id:      'toggle-minimap',
      default: true,
      onChange: v => window.__raycaster?.setMinimapVisible(v),
    },

    // ── Dev Mode ───────────────────────────────────────────────────────
    // Gated by the IS_DEV build flag. When IS_DEV is false the row is
    // hidden and state is permanently false, so all descendants are also
    // hidden via the requires chain without any extra logic.
    devMode: {
      id:        'toggle-devmode',
      default:   false,
      flagGate:  'IS_DEV',    // row hidden entirely when IS_DEV is false
      whenAbsent: 'hide',     // used by children: if devMode toggle is OFF,
                              // hide descendants (not just disable them)
    },

    // ── Debug layer ────────────────────────────────────────────────────
    // Depends on the devMode TOGGLE being on, not directly on IS_DEV.
    debug: {
      id:         'toggle-debug',
      default:    false,
      requires:   'devMode',
      whenAbsent: 'hide',     // no devMode → debug row disappears entirely
      onChange:   v => window.__raycaster?.setDebug(v),
    },

    // ── Performance overlay ────────────────────────────────────────────
    // Depends on the debug TOGGLE. Visible but locked while debug is off;
    // inherits 'hide' automatically if debug (or devMode) resolves to hidden.
    perf: {
      id:         'toggle-perf',
      default:    false,
      requires:   'debug',
      whenAbsent: 'disable',
      onChange:   v => window.__raycaster?.setPerf(v),
    },
  };

  /* ── Internal state ──────────────────────────────────────────────────── */

  // Flat key→boolean map; built from SETTINGS_CONFIG defaults on init.
  const state = {};

  /* ── Visibility resolution ───────────────────────────────────────────── */

  /**
   * Walk the full `requires` ancestor chain for `key` and return the
   * effective visibility token for its row.
   *
   * Checks in order:
   *   1. flagGate  — if the entry has a flagGate and the named DEV_FLAGS key
   *                  is false, return 'hide' immediately.  Build flags are
   *                  constants; this branch is evaluated but never changes.
   *   2. requires chain — walk parent links; accumulate the most restrictive
   *                  whenAbsent mode seen along the way.
   *
   * Returns:
   *   'on'      — every ancestor is satisfied; row is fully interactive
   *   'disable' — some ancestor is off; show row but dim + lock it
   *   'hide'    — some ancestor is off AND its whenAbsent is 'hide', OR a
   *               flagGate is false; row must not appear in the layout at all
   *
   * The rule: 'hide' beats 'disable' beats 'on'.
   *
   * @param   {string} key
   * @returns {'on'|'disable'|'hide'}
   */
  function _resolveVisibility(key) {
    const cfg = SETTINGS_CONFIG[key];

    // ── Step 1: flag gate ────────────────────────────────────────────
    // A flagGate is a build-time constant — if it is false the row is
    // unconditionally hidden.  No need to walk the chain further.
    if (cfg?.flagGate && !DEV_FLAGS[cfg.flagGate]) return 'hide';

    // ── Step 2: requires chain ───────────────────────────────────────
    let current = key;
    let result  = 'on';

    while (true) {
      const c = SETTINGS_CONFIG[current];
      if (!c?.requires) break;                        // reached the root

      // Also check the parent's own flagGate — if the parent is flag-hidden,
      // the child must be hidden too regardless of the child's whenAbsent.
      const parentCfg = SETTINGS_CONFIG[c.requires];
      if (parentCfg?.flagGate && !DEV_FLAGS[parentCfg.flagGate]) {
        return 'hide';
      }

      const parentOn = state[c.requires] === true;
      if (!parentOn) {
        const mode = c.whenAbsent ?? 'disable';
        result = (mode === 'hide' || result === 'hide') ? 'hide' : 'disable';
      }

      current = c.requires;                           // climb one level
    }

    return result;
  }

  /* ── DOM sync ────────────────────────────────────────────────────────── */

  /**
   * Push the current state + resolved visibility for `key` into the DOM.
   *
   * Three possible row states (mutually exclusive CSS classes):
   *   (neither class)        — fully interactive
   *   .cfg-row-disabled      — visible but dimmed, pointer-events:none
   *   .cfg-row-hidden        — display:none; not in layout at all
   *
   * @param {string} key
   */
  function _syncDom(key) {
    const cfg = SETTINGS_CONFIG[key];
    if (!cfg) return;

    const input = document.getElementById(cfg.id);
    if (!input) return;

    const visibility = _resolveVisibility(key);
    const blocked    = visibility !== 'on';

    // Checkbox: force off and disable when not fully on.
    input.checked  = blocked ? false : state[key];
    input.disabled = blocked;

    // Row: apply the appropriate visual class.
    const row = input.closest('.cfg-toggle-row');
    if (row) {
      row.classList.toggle('cfg-row-hidden',   visibility === 'hide');
      row.classList.toggle('cfg-row-disabled', visibility === 'disable');
    }
  }

  /* ── Public API ──────────────────────────────────────────────────────── */

  /**
   * Update a setting.  Enforces all constraints, syncs DOM, fires onChange.
   *
   * @param {string}  key   — key from SETTINGS_CONFIG
   * @param {boolean} value — desired value (may be clamped by constraints)
   */
  function set(key, value) {
    const cfg = SETTINGS_CONFIG[key];
    if (!cfg) return;

    // ── Constraint: requires (full-chain) ────────────────────────────
    // Block the value if any ancestor in the chain is off, not just the
    // direct parent.  _resolveVisibility walks the full chain.
    if (_resolveVisibility(key) !== 'on') value = false;

    state[key] = value;
    _syncDom(key);

    // ── Constraint: mutuallyExclusive ─────────────────────────────────
    // When turning a group member ON, force all siblings in the group OFF.
    if (cfg.group && value) {
      for (const [otherKey, otherCfg] of Object.entries(SETTINGS_CONFIG)) {
        if (otherKey !== key && otherCfg.group === cfg.group && state[otherKey]) {
          state[otherKey] = false;
          _syncDom(otherKey);
          otherCfg.onChange?.(false);
        }
      }
    }

    // ── Cascade: re-sync the full descendant subtree of this key ────────
    // _resolveVisibility is only called when _syncDom is called — it does
    // not run automatically.  A flat loop over direct children leaves
    // grandchildren with stale CSS classes.  _syncSubtree recurses the
    // entire descendant tree so every node re-evaluates its ancestor chain.
    _syncSubtree(key, value);

    cfg.onChange?.(value);
  }

  /**
   * Recursively re-sync every descendant of `parentKey` after its value
   * changed.
   *
   * For each direct child:
   *   - If the parent just turned OFF and the child was ON, force the child
   *     to false and fire its onChange before touching the DOM.
   *   - Call _syncDom so the child re-evaluates its full ancestor chain via
   *     _resolveVisibility (picks up the correct 'on'/'disable'/'hide').
   *   - Recurse into the child's own subtree so grandchildren update too.
   *
   * @param {string}  parentKey
   * @param {boolean} parentValue — the new value of parentKey
   */
  function _syncSubtree(parentKey, parentValue) {
    for (const [childKey, childCfg] of Object.entries(SETTINGS_CONFIG)) {
      if (childCfg.requires !== parentKey) continue;

      // Parent turned off — force child state to false and notify engine.
      if (!parentValue && state[childKey]) {
        state[childKey] = false;
        childCfg.onChange?.(false);
      }

      // Re-evaluate this child's full ancestor chain and update its DOM.
      _syncDom(childKey);

      // Recurse — grandchildren depend on this child's new effective state.
      _syncSubtree(childKey, state[childKey]);
    }
  }

  /* ── Initialisation ──────────────────────────────────────────────────── */

  /**
   * Wire up every setting: seed state from defaults, sync DOM once, attach
   * the change listener that routes through set().
   */
  function init() {
    for (const [key, cfg] of Object.entries(SETTINGS_CONFIG)) {
      state[key] = cfg.default ?? false;

      const input = document.getElementById(cfg.id);
      if (!input) continue;

      // Seed the checkbox to reflect the default before the user touches it.
      input.checked = state[key];

      input.addEventListener('change', function () {
        set(key, this.checked);
      });
    }

    // Full DOM sync pass — resolves any dependency-locked rows on load.
    for (const key of Object.keys(SETTINGS_CONFIG)) _syncDom(key);
  }

  init();

  // Expose for programmatic use (e.g., main.js restoring saved preferences).
  window._settings = { set, get: key => state[key] };

  // Expose the build flag so main.js can gate F3 and other dev-only hotkeys
  // without duplicating the constant.  Written once — never changes at runtime.
  window._isDevMode = IS_DEV;
})();


/* ═══════════════════════════════════════════════════════════════════════════
   2. FULLSCREEN TOGGLE
   ═══════════════════════════════════════════════════════════════════════════
   Swaps the SVG icon between expand and compress glyphs.  On mobile, requests
   landscape orientation lock after entering fullscreen.               */
(function () {
  const btn  = document.getElementById('fs-btn');
  const icon = document.getElementById('fs-icon');

  // Polyline point strings for the four-corner fullscreen glyphs.
  const EXPAND   = 'M1,6 1,1 6,1 M12,1 17,1 17,6 M17,12 17,17 12,17 M1,12 1,17 6,17';
  const COMPRESS = 'M6,1 1,1 1,6 M17,6 17,1 12,1 M12,17 17,17 17,12 M1,12 1,17 6,17';

  /**
   * Update each <polyline> in the icon to match the compress or expand glyph.
   * @param {boolean} compress — true → show compress icon
   */
  function setIcon(compress) {
    icon.querySelectorAll('polyline').forEach((p, i) => {
      const segs = (compress ? COMPRESS : EXPAND).split(' M');
      p.setAttribute('points', (i === 0 ? segs[0] : 'M' + segs[i]).replace(/^M/, ''));
    });
  }

  btn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen({navigationUI: 'hide'})
        .then(() => { screen.orientation?.lock?.('landscape').catch(() => {}); })
        .catch(err => console.warn('Fullscreen failed:', err));
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  document.addEventListener('fullscreenchange', () => {
    const active = !!document.fullscreenElement;
    document.body.classList.toggle('is-fullscreen', active);
    btn.classList.toggle('active', active);
    setIcon(active);
    btn.title = active ? 'Exit fullscreen' : 'Toggle fullscreen';
  });
})();


/* ═══════════════════════════════════════════════════════════════════════════
   3. SETTINGS PANEL
   ═══════════════════════════════════════════════════════════════════════════
   Controls open/close state, context labels (PAUSED vs SETTINGS),
   the bounce entry animation timing, and mouse/touch parallax tilt.

   Public API:  window._cfgPanel = { open(ctx), close() }
   Callers:     HUD gear button (ctx = 'game'), start menu (ctx = 'start')

   Parallax tilt
   ─────────────
   On desktop, cursor position within the overlay is mapped to --x / --y CSS
   custom properties on #cfg-panel, producing a subtle 3-D tilt effect.
   On touch devices the same calculation runs on touchstart/touchmove but
   with both axes inverted so the card tilts toward the finger rather than
   away from it.  Reduced-motion users skip both effects entirely.      */
(function () {
  const cfgBtn   = document.getElementById('cfg-btn');
  const overlay  = document.getElementById('cfg-overlay');
  const panel    = document.getElementById('cfg-panel');
  const closeBtn = document.getElementById('cfg-close-btn');
  const resumeBtn = document.getElementById('cfg-resume-btn');
  const titleEl  = document.querySelector('.cfg-title-text');

  let isOpen       = false;
  let _fromGame    = false;
  let _isOpenTimer = null;

  // Duration the entry bounce animation takes before switching to the faster
  // mouse-tracking transition. Must match the CSS transition on #cfg-panel.
  const PANEL_SETTLE_MS  = 310;
  // Divisor mapping cursor offset from panel centre to rotation degrees.
  // Larger value → subtler tilt.
  const PANEL_TILT_SCALE = 28;

  /**
   * Open the settings panel.
   * @param {'game'|'start'} ctx
   *   'game'  — opened mid-play; pauses the RAF loop and shows "PAUSED"
   *   'start' — opened from the start menu; shows "SETTINGS", no pause
   */
  function open(ctx) {
    _fromGame = (ctx !== 'start');
    isOpen    = true;

    // Context-specific copy
    titleEl.textContent   = _fromGame ? 'PAUSED'   : 'SETTINGS';
    resumeBtn.textContent = _fromGame ? 'Resume'   : 'Back';
    closeBtn.setAttribute('aria-label', _fromGame ? 'Resume' : 'Close settings');

    // Reset parallax vars so entry animation starts clean
    panel.style.removeProperty('--x');
    panel.style.removeProperty('--y');

    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    cfgBtn.classList.add('active');

    // Only pause the raycaster RAF loop when opened during gameplay
    if (_fromGame) window.__raycaster?.setPaused(true);

    // ── Sync debug checkboxes from live engine state ─────────────────
    // F3 can change _debugMode without touching the settings panel DOM.
    // When IS_DEV is true and the panel opens, push the current mode
    // back into the two checkboxes so they reflect reality.
    // _settings.set() goes through the full constraint chain, keeping
    // the devMode → debug → perf requires hierarchy intact.
    if (window._isDevMode) {
      const mode = window.__raycaster?.getDebugMode?.() ?? 0;
      window._settings?.set('debug', mode >= 1);
      window._settings?.set('perf',  mode >= 2);
    }

    // After the bounce entry settles (~300ms), add is-open so the panel
    // transitions to fast mouse-tracking speed (0.08s ease).
    clearTimeout(_isOpenTimer);
    _isOpenTimer = setTimeout(() => overlay.classList.add('is-open'), PANEL_SETTLE_MS);
  }

  /** Close the settings panel and resume gameplay if it was paused. */
  function close() {
    clearTimeout(_isOpenTimer);
    isOpen = false;
    overlay.classList.remove('open', 'is-open');
    overlay.setAttribute('aria-hidden', 'true');
    cfgBtn.classList.remove('active');
    panel.style.removeProperty('--x');
    panel.style.removeProperty('--y');
    if (_fromGame) window.__raycaster?.setPaused(false);
  }

  // Gear HUD button always opens from game context
  function toggle() { isOpen ? close() : open('game'); }

  cfgBtn.addEventListener('click', toggle);
  closeBtn.addEventListener('click', close);
  resumeBtn.addEventListener('click', close);

  // Backdrop click (not card) closes
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen) { e.preventDefault(); close(); }
  });

  // ── Panel parallax ──────────────────────────────────────────────────
  const motionOK = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  const isTouch  = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  if (motionOK) {
    if (!isTouch) {
      // Desktop: cursor moves away from centre → card tilts toward cursor
      overlay.addEventListener('mousemove', ({clientX, clientY}) => {
        if (!isOpen) return;
        const rect = panel.getBoundingClientRect();
        if (!rect.width) return;
        const dx = clientX - (rect.x + rect.width  * 0.5);
        const dy = clientY - (rect.y + rect.height * 0.5);
        panel.style.setProperty('--x', `${dy  / PANEL_TILT_SCALE}deg`);
        panel.style.setProperty('--y', `${dx  / PANEL_TILT_SCALE}deg`);
      });

      overlay.addEventListener('mouseleave', () => {
        panel.style.setProperty('--x', '0deg');
        panel.style.setProperty('--y', '0deg');
      });
    } else {
      // Mobile: invert both axes — card tilts toward the finger
      function applyPanelTilt(touch) {
        const rect = panel.getBoundingClientRect();
        if (!rect.width) return;
        const dx = touch.clientX - (rect.x + rect.width  * 0.5);
        const dy = touch.clientY - (rect.y + rect.height * 0.5);
        panel.style.setProperty('--x', `${-(dy / PANEL_TILT_SCALE)}deg`);
        panel.style.setProperty('--y', `${-(dx / PANEL_TILT_SCALE)}deg`);
      }

      overlay.addEventListener('touchstart', e => {
        if (!isOpen) return;
        applyPanelTilt(e.touches[0]);
      }, {passive: true});

      overlay.addEventListener('touchmove', e => {
        if (!isOpen) return;
        applyPanelTilt(e.touches[0]);
      }, {passive: true});
    }
  }

  // Expose so the start menu and any other caller can open with context
  window._cfgPanel = { open, close };
})();


/* ═══════════════════════════════════════════════════════════════════════════
   4. RESOLUTION CUSTOM DROPDOWN
   ═══════════════════════════════════════════════════════════════════════════
   Implements an accessible custom listbox (role="listbox", aria-selected) on
   top of the plain <ul> in index.html.  The selected value is forwarded to
   window.__raycaster.setResolution(w, h).

   The 'recommended' badge is injected lazily by window._onResDetected() once
   main.js has auto-detected the best resolution for the device.

   Public API:  window._resDropdown = { selectValue(value, skipCallback), LABELS, list }
   Callers:     window._onResDetected (section 8)                       */
(function () {
  const btn      = document.getElementById('res-dropdown-btn');
  const list     = document.getElementById('res-dropdown-list');
  const labelEl  = document.getElementById('res-dropdown-label');
  const dropdown = document.getElementById('res-dropdown');
  let currentValue = '';

  // Human-readable labels for each resolution value string.
  const LABELS = {
    '960x480':   '480p',
    '1280x640':  '720p',
    '1920x960':  '1080p',
    '2560x1280': '1440p',
    '3840x1920': '4K',
  };

  /**
   * Toggle the open/closed state of the dropdown.
   * @param {boolean} open
   */
  function setOpen(open) {
    list.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open);
    dropdown.classList.toggle('is-open', open);
  }

  /**
   * Set the active resolution value.
   * Updates the button face label (including any badge), marks the correct
   * list item as selected, and optionally forwards to the engine.
   *
   * @param {string}  value        — e.g. '1280x640'
   * @param {boolean} skipCallback — true when called during init/sync to
   *                                 avoid a redundant setResolution call
   */
  function selectValue(value, skipCallback) {
    currentValue = value;

    // Rebuild button label from the selected item's text + any badge.
    const item  = list.querySelector(`[data-value="${value}"]`);
    const badge = item ? item.querySelector('.res-item-badge') : null;
    labelEl.textContent = LABELS[value] || value;
    if (badge) {
      const b = badge.cloneNode(true);
      labelEl.appendChild(document.createTextNode('\u00a0'));
      labelEl.appendChild(b);
    }

    // Mark selected item in the listbox.
    list.querySelectorAll('.res-dropdown-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.value === value);
      el.setAttribute('aria-selected', el.dataset.value === value);
    });

    if (!skipCallback) {
      const [w, h] = value.split('x').map(Number);
      window.__raycaster?.setResolution(w, h);
    }
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    setOpen(!list.classList.contains('open'));
  });

  list.querySelectorAll('.res-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      selectValue(item.dataset.value);
      setOpen(false);
    });
  });

  // Close on outside click or Escape.
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });

  // Expose for the recommended sync in section 8.
  window._resDropdown = { selectValue, LABELS, list };
})();


/* ═══════════════════════════════════════════════════════════════════════════
   5. SETTINGS NAV SCROLL
   ═══════════════════════════════════════════════════════════════════════════
   Keeps the left-nav highlight in sync with which section is visible in the
   scrollable right column.  Activation uses the vertical midpoint of the
   content area rather than the top edge, which feels more accurate when
   sections are taller than the container.                              */
(function () {
  const content  = document.getElementById('cfg-content');
  const navItems = document.querySelectorAll('.cfg-nav-item[data-target]');

  // How far above a section's offsetTop to land after a click-scroll so the
  // heading is visible rather than clipped behind the content edge.
  const SCROLL_HEADING_OFFSET = 64;

  /**
   * Add the 'active' class to the nav item matching targetId, remove from all
   * others.
   * @param {string} targetId
   */
  function activateNav(targetId) {
    navItems.forEach(n => n.classList.toggle('active', n.dataset.target === targetId));
  }

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const sect = document.getElementById(item.dataset.target);
      if (!sect || !content) return;
      activateNav(item.dataset.target);
      content.scrollTo({top: sect.offsetTop - SCROLL_HEADING_OFFSET, behavior: 'smooth'});
    });
  });

  if (content) {
    content.addEventListener('scroll', () => {
      // A section becomes active once its top edge scrolls above the midpoint
      // of the visible area.
      const midpoint = content.scrollTop + content.clientHeight / 2;
      const sections = [...document.querySelectorAll('.cfg-section')];
      let current = sections[0]?.id;
      for (const s of sections) {
        if (s.offsetTop <= midpoint) current = s.id;
      }
      activateNav(current);
    }, {passive: true});
  }
})();


/* ═══════════════════════════════════════════════════════════════════════════
   6. SLIDER VALUE DISPLAY
   ═══════════════════════════════════════════════════════════════════════════
   Binds each range input to a sibling <span> that shows the live value.
   The optional format function allows custom display (e.g. appending a unit).
   Add new sliders to SLIDER_BINDINGS; do not add individual listeners.  */
(function () {
  /**
   * Each entry: [sliderId, valueSpanId, formatFn]
   * formatFn receives the raw string value and returns the display string.
   */
  const SLIDER_BINDINGS = [
    ['slider-speed',    'val-speed',    v => v],
    ['slider-range',    'val-range',    v => v],
    ['slider-fov',      'val-fov',      v => v + '°', v => window.__raycaster?.setFov(Number(v))],
    ['slider-fog-dist', 'val-fog-dist', v => v,        v => window.__raycaster?.setFogDist(Number(v))],
    ['slider-sens',     'val-sens',     v => v],
    ['slider-clip',     'val-clip',     v => (v / 10).toFixed(1)],
    ['slider-bright',   'val-bright',   v => v],
    ['slider-master',   'val-master',   v => v],
    ['slider-music',    'val-music',    v => v],
    ['slider-sfx',      'val-sfx',      v => v],
  ];

  SLIDER_BINDINGS.forEach(([sliderId, valId, fmt, onChange]) => {
    const s = document.getElementById(sliderId);
    const v = document.getElementById(valId);
    if (!s || !v) return;
    s.addEventListener('input', () => {
      v.textContent = fmt(s.value);
      onChange?.(s.value);
    });
  });
})();


/* ═══════════════════════════════════════════════════════════════════════════
   7. START MENU
   ═══════════════════════════════════════════════════════════════════════════
   Manages the full-viewport start overlay shown before the game begins.
   The overlay starts hidden (display:none, set in JS to avoid flash) and is
   made visible by window._showStart(), which main.js calls after the engine
   and resolution auto-detect have finished.

   HUD buttons (#cfg-btn, #fs-btn) are hidden while the start menu is
   showing — they make no sense before the game starts.

   Arrow-key roving focus lets keyboard users navigate the button list.

   Parallax tilt mirrors the settings-panel system (see section 3) but maps
   cursor/touch offset to --x / --y on the menu list element itself.     */
(function () {
  const overlay     = document.getElementById('start-overlay');
  const menuList    = document.getElementById('start-menu-list');
  const playBtn     = document.getElementById('start-play-btn');
  const settingsBtn = document.getElementById('start-settings-btn');
  const cfgBtn      = document.getElementById('cfg-btn');
  const fsBtn       = document.getElementById('fs-btn');

  // Hidden until main.js calls _showStart() after autoDetectResolution.
  overlay.style.display = 'none';

  // HUD buttons only make sense in-game — hide them until Play is pressed.
  cfgBtn.style.visibility = 'hidden';
  fsBtn.style.visibility  = 'hidden';

  playBtn.addEventListener('click', () => {
    overlay.style.display = 'none';
    cfgBtn.style.visibility = '';
    fsBtn.style.visibility  = '';
    window.__raycaster?.start();
  });

  settingsBtn.addEventListener('click', () => {
    // Open in 'start' context: no pause, title reads "SETTINGS"
    window._cfgPanel?.open('start');
  });

  // ── Arrow-key roving focus ────────────────────────────────────────
  // Allows Up/Down/Left/Right to move between menu buttons without
  // the user having to Tab through them.
  menuList.addEventListener('keydown', e => {
    const items = [...menuList.querySelectorAll('button')];
    const idx   = items.indexOf(document.activeElement);
    if (idx === -1) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      items[(idx + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length].focus();
    }
  });

  // ── Menu parallax ─────────────────────────────────────────────────
  const motionOK = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  // Maps cursor/touch offset from the menu list centre to rotation degrees.
  const MENU_TILT_SCALE = 20;
  const isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  if (motionOK) {
    if (!isTouch) {
      // Desktop: pause the idle float animation while the cursor is over the
      // menu, and tilt the list away from the cursor position.
      overlay.addEventListener('mouseenter', () => {
        menuList.style.animationPlayState = 'paused';
      });

      overlay.addEventListener('mouseleave', () => {
        menuList.style.animationPlayState = '';
        menuList.style.removeProperty('--x');
        menuList.style.removeProperty('--y');
      });

      overlay.addEventListener('mousemove', ({clientX, clientY}) => {
        const rect = menuList.getBoundingClientRect();
        if (!rect.width) return;
        const dx = clientX - (rect.x + rect.width  * 0.5);
        const dy = clientY - (rect.y + rect.height * 0.5);
        menuList.style.setProperty('--x', `${dy  / MENU_TILT_SCALE}deg`);
        menuList.style.setProperty('--y', `${dx  / MENU_TILT_SCALE}deg`);
      });
    } else {
      // Mobile: invert both axes — list tilts toward the finger.
      function applyMenuTilt(touch) {
        const rect = menuList.getBoundingClientRect();
        if (!rect.width) return;
        const dx = touch.clientX - (rect.x + rect.width  * 0.5);
        const dy = touch.clientY - (rect.y + rect.height * 0.5);
        menuList.style.setProperty('--x', `${-(dy / MENU_TILT_SCALE)}deg`);
        menuList.style.setProperty('--y', `${-(dy / MENU_TILT_SCALE)}deg`);
      }

      overlay.addEventListener('touchstart', e => {
        menuList.style.animationPlayState = 'paused';
        applyMenuTilt(e.touches[0]);
      }, {passive: true});

      overlay.addEventListener('touchend', () => {
        menuList.style.animationPlayState = '';
        // Tilt intentionally preserved — no reset to 0deg
      });

      overlay.addEventListener('touchmove', e => {
        applyMenuTilt(e.touches[0]);
      }, {passive: true});
    }
  }

  /**
   * Called by main.js once autoDetectResolution resolves.
   * Makes the overlay visible and moves focus to the Play button.
   */
  window._showStart = function () {
    overlay.style.display = '';
    playBtn.focus();
  };
})();


/* ═══════════════════════════════════════════════════════════════════════════
   8. RESOLUTION DETECTED CALLBACK
   ═══════════════════════════════════════════════════════════════════════════
   Called by main.js (an ES module) after auto-detecting the recommended
   render resolution.  Cannot use the 'load' event for this because main.js
   uses top-level await, so window.__raycaster is set after 'load' fires.

   Steps:
     1. Inject the 'recommended' badge into the correct list item.
     2. Call selectValue() (skipCallback=true) so the badge is cloned into
        the dropdown button face without triggering a redundant setResolution.
                                                                         */
window._onResDetected = function (value) {
  const rd = window._resDropdown;
  if (!rd) return;

  // Inject badge into the list item first so selectValue can clone it.
  const item = rd.list.querySelector(`[data-value="${value}"]`);
  if (item && !item.querySelector('.res-item-badge')) {
    const badge = document.createElement('span');
    badge.className   = 'res-item-badge';
    badge.textContent = 'recommended';
    item.appendChild(badge);
  }

  // selectValue clones the badge into the button face.
  rd.selectValue(value, true);
};


/* ═══════════════════════════════════════════════════════════════════════════
   9. DEBUG OVERLAY — DOM CLICK OVERLAY
   ═══════════════════════════════════════════════════════════════════════════
   The HUD canvas is pointer-events:none.  A single transparent hit area div
   (#dbg-hit-area) sits above the canvas (z-index 5) and covers the full
   left debug panel.  Click and touch events on it resolve which section
   header was hit by walking the same cy progression that drawDebugOverlay()
   uses — so geometry is always computed from live state and can never drift.

   Previous approach used four individual hit divs repositioned via a rAF
   loop.  That broke because:
     1. cy += lh was accumulated per iteration (wrong — lh only appears once
        at initialisation in drawDebugOverlay).
     2. Verbose timing rows were not counted, shifting lower headers.
     3. Height-guard force-collapsing was not reflected.
     4. click fires ~300ms late on mobile; touchend was missing.

   Current approach eliminates all four bugs:
     1/2/3 — hit-test computed at event time with full live state.
     4     — touchend fires immediately with preventDefault().         */
(function () {

  const SECTIONS = [
    { id: 'performance' },
    { id: 'player'      },
    { id: 'rendering'   },
    { id: 'networking'  },
  ];

  // ── Single transparent hit area ──────────────────────────────────
  const hitArea = document.createElement('div');
  hitArea.id = 'dbg-hit-area';
  hitArea.style.cssText =
    'position:fixed;pointer-events:none;z-index:5;' +
    'box-sizing:border-box;display:none;cursor:pointer;';
  document.documentElement.appendChild(hitArea);

  // ── Hit-test: which section header contains clientY? ─────────────
  // Replicates drawDebugOverlay()'s cy progression in CSS pixels so
  // the result always matches what the canvas actually drew.
  function _sectionAtY(clientY) {
    const rc  = window.__raycaster;
    const sec = window.__debugSections;
    if (!rc || !sec) return null;

    const canvas = document.querySelector('#c');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    if (!r.width) return null;

    const scale  = r.width / 800;          // CSS-px scale (no DPR)
    const pad    = Math.round(8  * scale);
    const lh     = Math.round(18 * scale);
    const rowH   = Math.round(16 * scale);
    const safeH  = r.height - pad;         // CSS-px equivalent of hudH − pad
    const mode   = rc.getDebugMode?.() ?? 0;
    const hasMem = !!(window.performance?.memory);

    const y = clientY - r.top;   // y relative to canvas top

    // Walk cy exactly as drawDebugOverlay does.
    // cy at each iteration is the header baseline for that section.
    let cy = pad + lh;

    for (const { id } of SECTIONS) {
      // Header background occupies [cy − lh + 3*scale, cy − lh + 3*scale + lh].
      const hdrTop = cy - lh + Math.round(3 * scale);
      const hdrBot = hdrTop + lh;
      if (y >= hdrTop && y <= hdrBot) return id;

      // Advance past this section's content to reach the next header.
      cy += Math.round(4 * scale);   // post-header gap

      // Determine effective collapse (permanent OR height-guard).
      const permCollapsed  = sec.get(id) ?? false;
      const minR           = id === 'performance' ? 3 : 4;
      const forceCollapsed = (cy + rowH * minR) > safeH;
      const collapsed      = permCollapsed || forceCollapsed;

      if (!collapsed) {
        if (id === 'performance') {
          cy += rowH * 3;                       // fps, frame, gpu
          if (hasMem) cy += rowH;               // memory (if API present)
          // Mode 2 only: vsync + per-component breakdown
          if (mode >= 2 && (cy + rowH * 8 + Math.round(12 * scale)) <= safeH) {
            cy += Math.round(5 * scale) + Math.round(7 * scale); // innerSep
            cy += rowH * 3;                     // raf, vsync idle, pipeline
            cy += Math.round(5 * scale) + Math.round(7 * scale); // innerSep
            cy += rowH * 6;                     // update, rays, minimap, hud, gpu%, fill rate
          }
        } else if (id === 'player') {
          cy += rowH * 4;                       // pos, vel, angle, input
          // Always: extended physics (innerSep + 3 rows)
          cy += Math.round(5 * scale) + Math.round(7 * scale);
          cy += rowH * 3;                       // facing, speed, radius
        } else if (id === 'rendering') {
          cy += rowH * 4;                       // res, fov, fog dist, gpu
          // Always: world/shader stats (innerSep + 4 rows)
          cy += Math.round(5 * scale) + Math.round(7 * scale);
          cy += rowH * 4;                       // segments, tex layers, world, fog amt
        } else {
          cy += rowH * 4;                       // networking: 4 rows
        }
      }

      // Inter-section separator gap — matches the two cy += 8 in drawDebugOverlay.
      cy += Math.round(8 * scale) + Math.round(8 * scale);
      // cy is now the next section's header baseline (no extra lh — lh is
      // baked into the initial cy = pad + lh and never re-added per section).
    }

    return null;
  }

  // ── Toggle helper ────────────────────────────────────────────────
  function _toggle(clientY) {
    const rc  = window.__raycaster;
    const sec = window.__debugSections;
    if (!rc || !sec) return;
    const id = _sectionAtY(clientY);
    if (!id) return;
    rc.toggleDebugSection(id, !(sec.get(id) ?? false));
  }

  // ── Desktop: click ───────────────────────────────────────────────
  hitArea.addEventListener('click', e => _toggle(e.clientY));

  // ── Mobile: touchend fires immediately; preventDefault suppresses
  //    the ~300ms-delayed click that would fire otherwise.
  hitArea.addEventListener('touchend', e => {
    if (!e.changedTouches.length) return;
    e.preventDefault();
    _toggle(e.changedTouches[0].clientY);
  }, { passive: false });

  // ── rAF sync: position and size the hit area over the left panel ─
  // No per-section geometry needed — just cover the whole panel.
  function _sync() {
    const rc        = window.__raycaster;
    const debugMode = rc?.getDebugMode?.() ?? 0;
    const active    = debugMode >= 1 && !!window._isDevMode;

    hitArea.style.display       = active ? '' : 'none';
    hitArea.style.pointerEvents = active ? 'auto' : 'none';

    if (!active) return;

    const canvas = document.querySelector('#c');
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;

    const scale  = r.width / 800;
    const pad    = Math.round(8  * scale);
    const panelW = Math.round(252 * scale);
    const maxH   = Math.round(660 * scale);

    hitArea.style.left   = (r.left + pad) + 'px';
    hitArea.style.top    = (r.top  + pad) + 'px';
    hitArea.style.width  = panelW + 'px';
    hitArea.style.height = Math.min(maxH, r.height - pad * 2) + 'px';
  }

  (function loop() { _sync(); requestAnimationFrame(loop); })();

  // ── Bridge shim ──────────────────────────────────────────────────
  // Intercepts the window.__raycaster assignment from main.js and
  // injects toggleDebugSection so ui.js doesn't need an ES import.
  let _rc = null;
  Object.defineProperty(window, '__raycaster', {
    get() { return _rc; },
    set(v) {
      _rc = v;
      if (v) {
        v.toggleDebugSection = function (id, collapsed) {
          v._setDebugSection?.(id, collapsed);
        };
      }
    },
    configurable: true,
  });
})();

