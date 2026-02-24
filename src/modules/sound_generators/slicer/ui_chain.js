/*
 * Slicer — ui_chain.js
 * Shadow UI for the Slicer module
 * Handles file browsing, slice visualization, and parameter display
 */

(function () {
  "use strict";

  /* ── Constants ─────────────────────────────────────────────────────────── */
  const SAMPLE_RATE = 44100;
  const SAMPLES_DIR = "/data/UserData/UserLibrary/Samples";

  const CC_JOG    = 14;
  const CC_KNOB1  = 71;
  const CC_KNOB2  = 72;
  const CC_KNOB3  = 73;
  const CC_KNOB4  = 74;
  const CC_SHIFT  = 64;

  /* ── State ─────────────────────────────────────────────────────────────── */
  const state = {
    view: "main",          // "main" | "browser" | "advanced"
    shift: false,

    /* file browser */
    browser_path: SAMPLES_DIR,
    browser_entries: [],
    browser_cursor: 0,
    browser_scroll: 0,

    /* params (mirrors DSP) */
    sample_path: "",
    sample_name: "",
    sensitivity: 0.5,
    slices: 16,
    pitch: 0.0,
    gain: 0.8,
    mode: "trigger",
    attack: 5.0,
    decay: 200.0,
    start_trim: 0.0,
    end_trim: 1.0,
    slice_count_actual: 0,

    /* display */
    display_lines: [],
    dirty: true,
  };

  /* ── Helpers ───────────────────────────────────────────────────────────── */
  function getParam(key) {
    try {
      const val = host_module_get_param(key);
      return val !== undefined ? val : null;
    } catch (e) {
      return null;
    }
  }

  function setParam(key, val) {
    try {
      host_module_set_param(key, String(val));
    } catch (e) {}
  }

  function syncFromDSP() {
    const p = (k, fallback) => { const v = getParam(k); return v !== null ? v : fallback; };
    state.sample_path        = p("sample_path", "");
    state.sensitivity        = parseFloat(p("sensitivity", 0.5));
    state.slices             = parseInt(p("slices", 16));
    state.pitch              = parseFloat(p("pitch", 0.0));
    state.gain               = parseFloat(p("gain", 0.8));
    state.mode               = p("mode", "trigger");
    state.attack             = parseFloat(p("attack", 5.0));
    state.decay              = parseFloat(p("decay", 200.0));
    state.start_trim         = parseFloat(p("start_trim", 0.0));
    state.end_trim           = parseFloat(p("end_trim", 1.0));
    state.slice_count_actual = parseInt(p("slice_count_actual", 0));

    if (state.sample_path) {
      const parts = state.sample_path.split("/");
      state.sample_name = parts[parts.length - 1].replace(/\.wav$/i, "");
    } else {
      state.sample_name = "-- no sample --";
    }
    state.dirty = true;
  }

  /* ── File browser ──────────────────────────────────────────────────────── */
  function browserOpen(path) {
    state.browser_path    = path;
    state.browser_cursor  = 0;
    state.browser_scroll  = 0;
    state.browser_entries = [];

    try {
      const entries = host_fs_list(path);
      if (!entries) return;

      /* sort: dirs first, then files */
      const dirs  = entries.filter(e => e.type === "dir").sort((a,b) => a.name.localeCompare(b.name));
      const files = entries.filter(e => e.type === "file" && /\.wav$/i.test(e.name))
                           .sort((a,b) => a.name.localeCompare(b.name));

      /* add parent dir entry if not at root */
      if (path !== SAMPLES_DIR) {
        state.browser_entries.push({ name: "..", type: "dir", path: parentDir(path) });
      }

      dirs.forEach(d  => state.browser_entries.push({ name: d.name,  type: "dir",  path: path + "/" + d.name }));
      files.forEach(f => state.browser_entries.push({ name: f.name,  type: "file", path: path + "/" + f.name }));
    } catch (e) {}

    state.dirty = true;
  }

  function parentDir(path) {
    const parts = path.split("/");
    parts.pop();
    return parts.join("/") || "/";
  }

  function browserSelect() {
    const entry = state.browser_entries[state.browser_cursor];
    if (!entry) return;

    if (entry.type === "dir") {
      browserOpen(entry.path);
    } else {
      /* load sample */
      setParam("sample_path", entry.path);
      state.sample_path = entry.path;
      state.sample_name = entry.name.replace(/\.wav$/i, "");
      state.view = "main";
      state.dirty = true;
    }
  }

  function browserScroll(delta) {
    state.browser_cursor = Math.max(0,
      Math.min(state.browser_entries.length - 1, state.browser_cursor + delta));

    /* keep cursor in visible window (4 lines) */
    if (state.browser_cursor < state.browser_scroll) {
      state.browser_scroll = state.browser_cursor;
    } else if (state.browser_cursor >= state.browser_scroll + 4) {
      state.browser_scroll = state.browser_cursor - 3;
    }
    state.dirty = true;
  }

  /* ── Param editing ─────────────────────────────────────────────────────── */
  const SLICE_VALUES = [8, 16, 32, 64, 128];

  function adjustParam(key, delta) {
    switch (key) {
      case "sensitivity":
        state.sensitivity = Math.max(0, Math.min(1, state.sensitivity + delta * 0.05));
        setParam("sensitivity", state.sensitivity.toFixed(3));
        break;
      case "slices": {
        const idx = SLICE_VALUES.indexOf(state.slices);
        const next = SLICE_VALUES[Math.max(0, Math.min(SLICE_VALUES.length-1, idx + delta))];
        state.slices = next;
        setParam("slices", next);
        break;
      }
      case "pitch":
        state.pitch = Math.max(-24, Math.min(24, state.pitch + delta * 0.5));
        setParam("pitch", state.pitch.toFixed(1));
        break;
      case "gain":
        state.gain = Math.max(0, Math.min(1, state.gain + delta * 0.05));
        setParam("gain", state.gain.toFixed(3));
        break;
      case "attack":
        state.attack = Math.max(0, Math.min(500, state.attack + delta * 5));
        setParam("attack", state.attack.toFixed(1));
        break;
      case "decay":
        state.decay = Math.max(0, Math.min(2000, state.decay + delta * 20));
        setParam("decay", state.decay.toFixed(1));
        break;
      case "start_trim":
        state.start_trim = Math.max(0, Math.min(state.end_trim - 0.01, state.start_trim + delta * 0.01));
        setParam("start_trim", state.start_trim.toFixed(4));
        break;
      case "end_trim":
        state.end_trim = Math.max(state.start_trim + 0.01, Math.min(1, state.end_trim + delta * 0.01));
        setParam("end_trim", state.end_trim.toFixed(4));
        break;
      case "mode":
        state.mode = state.mode === "trigger" ? "gate" : "trigger";
        setParam("mode", state.mode);
        break;
    }
    state.dirty = true;
  }

  /* ── Display rendering ─────────────────────────────────────────────────── */
  function renderMain() {
    const name = state.sample_name.substring(0, 18) || "-- no sample --";
    const sliceBar = renderSliceBar(state.slice_count_actual, 16);
    return [
      `◈ ${name}`,
      `Sens:${(state.sensitivity * 100).toFixed(0).padStart(3)}%  Slc:${state.slices}`,
      `Pitch:${state.pitch >= 0 ? "+" : ""}${state.pitch.toFixed(1)}  Gain:${(state.gain*100).toFixed(0)}%`,
      sliceBar,
    ];
  }

  function renderAdvanced() {
    return [
      `Mode: ${state.mode.toUpperCase()}`,
      `Atk:${state.attack.toFixed(0)}ms  Dec:${state.decay.toFixed(0)}ms`,
      `Start:${(state.start_trim*100).toFixed(1)}%  End:${(state.end_trim*100).toFixed(1)}%`,
      `[Jog=mode  Knob1=atk  Knob2=dec]`,
    ];
  }

  function renderBrowser() {
    const lines = [];
    const visible = state.browser_entries.slice(state.browser_scroll, state.browser_scroll + 4);
    visible.forEach((e, i) => {
      const idx = state.browser_scroll + i;
      const cursor = idx === state.browser_cursor ? "▶" : " ";
      const icon   = e.type === "dir" ? "▸" : "♪";
      const name   = e.name.substring(0, 17);
      lines.push(`${cursor}${icon} ${name}`);
    });
    while (lines.length < 4) lines.push("");
    return lines;
  }

  function renderSliceBar(count, width) {
    if (count === 0) return "[ no slices detected ]";
    const filled = Math.round((count / 128) * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    return `[${bar}] ${count}`;
  }

  function pushDisplay(lines) {
    try {
      host_display_set_lines(lines[0] || "", lines[1] || "", lines[2] || "", lines[3] || "");
    } catch (e) {
      /* fallback if host API differs */
      try { host_display_update(lines.join("\n")); } catch (_) {}
    }
  }

  /* ── Main tick ─────────────────────────────────────────────────────────── */
  function tick() {
    if (!state.dirty) return;
    state.dirty = false;

    let lines;
    switch (state.view) {
      case "browser":  lines = renderBrowser();  break;
      case "advanced": lines = renderAdvanced(); break;
      default:         lines = renderMain();      break;
    }
    pushDisplay(lines);
  }

  /* ── MIDI handler ──────────────────────────────────────────────────────── */
  function onMidiMessageInternal(status, data1, data2) {
    const isCC = (status & 0xF0) === 0xB0;
    if (!isCC) return;

    const cc  = data1;
    const val = data2;

    /* shift button */
    if (cc === CC_SHIFT) {
      state.shift = val > 0;
      return;
    }

    /* jog wheel */
    if (cc === CC_JOG) {
      const delta = val < 64 ? val : val - 128; /* signed */

      if (state.view === "browser") {
        browserScroll(delta);
      } else if (state.view === "advanced") {
        adjustParam("mode", delta);
      } else {
        /* jog on main view scrolls sensitivity */
        adjustParam("sensitivity", delta);
      }
      return;
    }

    /* knobs in main view */
    if (state.view === "main") {
      const delta = val < 64 ? val : val - 128;
      if      (cc === CC_KNOB1) adjustParam("sensitivity", delta);
      else if (cc === CC_KNOB2) adjustParam("slices",      delta);
      else if (cc === CC_KNOB3) adjustParam("pitch",       delta);
      else if (cc === CC_KNOB4) adjustParam("gain",        delta);
    }

    /* knobs in advanced view */
    if (state.view === "advanced") {
      const delta = val < 64 ? val : val - 128;
      if      (cc === CC_KNOB1) adjustParam("attack",     delta);
      else if (cc === CC_KNOB2) adjustParam("decay",      delta);
      else if (cc === CC_KNOB3) adjustParam("start_trim", delta);
      else if (cc === CC_KNOB4) adjustParam("end_trim",   delta);
    }
  }

  /* ── Init ──────────────────────────────────────────────────────────────── */
  function init() {
    syncFromDSP();

    /* open file browser on Shift+Pad1 — host fires this as a specific message */
    try {
      host_on_button("pad1_shift", function () {
        if (state.view === "browser") {
          state.view = "main";
        } else {
          browserOpen(state.browser_path || SAMPLES_DIR);
          state.view = "browser";
        }
        state.dirty = true;
      });
    } catch (e) {}

    /* select in browser = jog push */
    try {
      host_on_button("jog_push", function () {
        if (state.view === "browser") {
          browserSelect();
        } else if (state.view === "main") {
          state.view = "advanced";
          state.dirty = true;
        } else if (state.view === "advanced") {
          state.view = "main";
          state.dirty = true;
        }
      });
    } catch (e) {}

    state.dirty = true;
  }

  /* ── Export ────────────────────────────────────────────────────────────── */
  globalThis.chain_ui = {
    init,
    tick,
    onMidiMessageInternal,
  };
})();
