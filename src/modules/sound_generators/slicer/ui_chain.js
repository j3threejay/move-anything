/*
 * Slicer — ui_chain.js
 * Shadow UI: file browser, slice visualiser, param editor.
 *
 * APIs used:
 *   os.readdir / os.stat   — directory listing
 *   clear_screen / print / fill_rect  — display
 *   onMidiMessageInternal  — all input (no host_on_button)
 */

import * as os from 'os';

import {
    MoveMainKnob, MoveMainButton, MoveBack,
    MoveKnob1, MoveKnob2, MoveKnob3, MoveKnob4
} from '/data/UserData/move-anything/shared/constants.mjs';

import { decodeDelta } from '/data/UserData/move-anything/shared/input_filter.mjs';

import {
    drawMenuHeader,
    drawMenuFooter
} from '/data/UserData/move-anything/shared/menu_layout.mjs';

/* ── Constants ───────────────────────────────────────────────────────────── */
const SAMPLES_DIR = "/data/UserData/UserLibrary/Samples";
const SCREEN_W    = 128;
const LINE_H      = 11;
const LIST_Y      = 16;    /* y below header */
const VISIBLE     = 4;     /* browser rows visible */

/* ── State ───────────────────────────────────────────────────────────────── */
const state = {
    view:       "main",   /* "main" | "browser" | "advanced" */
    dirty:      true,

    /* browser */
    browserPath:    SAMPLES_DIR,
    browserEntries: [],
    browserCursor:  0,
    browserScroll:  0,

    /* DSP params */
    samplePath:       "",
    sampleName:       "-- no sample --",
    sensitivity:      0.5,
    slices:           16,
    pitch:            0.0,
    gain:             0.8,
    mode:             "trigger",
    attack:           5.0,
    decay:            200.0,
    startTrim:        0.0,
    endTrim:          1.0,
    sliceCountActual: 0,
};

/* ── DSP param helpers ────────────────────────────────────────────────────── */
function getParam(key) {
    try {
        const v = host_module_get_param(key);
        return (v !== null && v !== undefined) ? String(v) : null;
    } catch (_) { return null; }
}

function setParam(key, val) {
    try { host_module_set_param(key, String(val)); } catch (_) {}
}

function syncFromDSP() {
    const f = (k, d) => { const v = getParam(k); return v !== null ? parseFloat(v) : d; };
    const s = (k, d) => { const v = getParam(k); return v !== null ? v : d; };
    const i = (k, d) => { const v = getParam(k); return v !== null ? parseInt(v, 10) : d; };

    state.samplePath       = s("sample_path",        "");
    state.sensitivity      = f("sensitivity",         0.5);
    state.slices           = i("slices",              16);
    state.pitch            = f("pitch",               0.0);
    state.gain             = f("gain",                0.8);
    state.mode             = s("mode",                "trigger");
    state.attack           = f("attack",              5.0);
    state.decay            = f("decay",               200.0);
    state.startTrim        = f("start_trim",          0.0);
    state.endTrim          = f("end_trim",            1.0);
    state.sliceCountActual = i("slice_count_actual",  0);

    if (state.samplePath) {
        const parts = state.samplePath.split("/");
        state.sampleName = parts[parts.length - 1].replace(/\.wav$/i, "");
    } else {
        state.sampleName = "-- no sample --";
    }
    state.dirty = true;
}

/* ── File browser ─────────────────────────────────────────────────────────── */
function entryIsDir(fullPath) {
    try {
        const [stat, err] = os.stat(fullPath) || [{}, 1];
        return !err && (stat.mode & 0o170000) === 0o040000;
    } catch (_) { return false; }
}

function browserOpen(path) {
    state.browserPath    = path;
    state.browserCursor  = 0;
    state.browserScroll  = 0;
    state.browserEntries = [];

    try {
        const [names, err] = os.readdir(path) || [[], 1];
        if (err || !Array.isArray(names)) return;

        const dirs = [], files = [];
        for (const name of names) {
            if (name === "." || name === "..") continue;
            const full = path + "/" + name;
            if (entryIsDir(full)) {
                dirs.push({ name, path: full, isDir: true });
            } else if (/\.wav$/i.test(name)) {
                files.push({ name, path: full, isDir: false });
            }
        }

        dirs.sort( (a, b) => a.name.localeCompare(b.name));
        files.sort((a, b) => a.name.localeCompare(b.name));

        /* parent entry unless we're at the root */
        if (path !== SAMPLES_DIR) {
            const up = path.split("/").slice(0, -1).join("/") || "/";
            state.browserEntries.push({ name: "..", path: up, isDir: true });
        }
        for (const d of dirs)  state.browserEntries.push(d);
        for (const f of files) state.browserEntries.push(f);
    } catch (_) {}

    state.dirty = true;
}

function browserScroll(delta) {
    const max = Math.max(0, state.browserEntries.length - 1);
    state.browserCursor = Math.max(0, Math.min(max, state.browserCursor + delta));

    if (state.browserCursor < state.browserScroll) {
        state.browserScroll = state.browserCursor;
    } else if (state.browserCursor >= state.browserScroll + VISIBLE) {
        state.browserScroll = state.browserCursor - VISIBLE + 1;
    }
    state.dirty = true;
}

function browserSelect() {
    const entry = state.browserEntries[state.browserCursor];
    if (!entry) return;

    if (entry.isDir) {
        browserOpen(entry.path);
    } else {
        setParam("sample_path", entry.path);
        state.samplePath = entry.path;
        state.sampleName = entry.name.replace(/\.wav$/i, "");
        state.view  = "main";
        state.dirty = true;
    }
}

/* ── Param adjustment ─────────────────────────────────────────────────────── */
const SLICE_VALUES = [8, 16, 32, 64, 128];

function adjustParam(key, delta) {
    switch (key) {
        case "sensitivity":
            state.sensitivity = Math.max(0, Math.min(1, state.sensitivity + delta * 0.05));
            setParam("sensitivity", state.sensitivity.toFixed(3));
            break;
        case "slices": {
            const idx  = SLICE_VALUES.indexOf(state.slices);
            const next = Math.max(0, Math.min(SLICE_VALUES.length - 1, idx + delta));
            state.slices = SLICE_VALUES[next];
            setParam("slices", state.slices);
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
            state.startTrim = Math.max(0, Math.min(state.endTrim - 0.01, state.startTrim + delta * 0.01));
            setParam("start_trim", state.startTrim.toFixed(4));
            break;
        case "end_trim":
            state.endTrim = Math.max(state.startTrim + 0.01, Math.min(1, state.endTrim + delta * 0.01));
            setParam("end_trim", state.endTrim.toFixed(4));
            break;
        case "mode":
            state.mode = (state.mode === "trigger") ? "gate" : "trigger";
            setParam("mode", state.mode);
            break;
    }
    state.dirty = true;
}

/* ── Display ──────────────────────────────────────────────────────────────── */
function drawMain() {
    clear_screen();
    drawMenuHeader("Slicer");

    /* sample name — truncate to fit */
    print(2, LIST_Y, state.sampleName.substring(0, 20), 1);

    /* row 2: sensitivity + slices */
    const sensStr = "Sns:" + Math.round(state.sensitivity * 100) + "%";
    const slcStr  = "Slc:" + state.slices;
    print(2,  LIST_Y + LINE_H,     sensStr, 1);
    print(70, LIST_Y + LINE_H,     slcStr,  1);

    /* row 3: pitch + gain */
    const sign     = state.pitch >= 0 ? "+" : "";
    const pitchStr = "Pch:" + sign + state.pitch.toFixed(1);
    const gainStr  = "Gain:" + Math.round(state.gain * 100) + "%";
    print(2,  LIST_Y + LINE_H * 2, pitchStr, 1);
    print(70, LIST_Y + LINE_H * 2, gainStr,  1);

    /* slice bar — pixel rectangle, proportional fill */
    const barX = 2, barY = LIST_Y + LINE_H * 3, barW = 80, barH = 6;
    draw_rect(barX, barY, barW, barH, 1);
    if (state.sliceCountActual > 0) {
        const fill = Math.round((state.sliceCountActual / 128) * (barW - 2));
        if (fill > 0) fill_rect(barX + 1, barY + 1, fill, barH - 2, 1);
        print(barX + barW + 2, barY, String(state.sliceCountActual), 1);
    }

    drawMenuFooter("Clk:browse  Bk:adv");
}

function drawBrowser() {
    clear_screen();
    drawMenuHeader("Load Sample");

    const visible = state.browserEntries.slice(state.browserScroll, state.browserScroll + VISIBLE);
    for (let i = 0; i < visible.length; i++) {
        const entry  = visible[i];
        const absIdx = state.browserScroll + i;
        const y      = LIST_Y + i * LINE_H;
        const sel    = absIdx === state.browserCursor;

        if (sel) fill_rect(0, y - 1, SCREEN_W, LINE_H, 1);

        const color = sel ? 0 : 1;
        const icon  = entry.isDir ? ">" : " ";
        print(2, y, icon + " " + entry.name.substring(0, 17), color);
    }

    drawMenuFooter("Jog:scroll  Clk:sel  Bk:exit");
}

function drawAdvanced() {
    clear_screen();
    drawMenuHeader("Slicer Adv");

    print(2, LIST_Y,             "Mode: " + state.mode.toUpperCase(), 1);
    print(2, LIST_Y + LINE_H,    "Atk:" + state.attack.toFixed(0) + "ms  Dec:" + state.decay.toFixed(0) + "ms", 1);
    print(2, LIST_Y + LINE_H*2,  "Sta:" + (state.startTrim * 100).toFixed(1) + "%  End:" + (state.endTrim * 100).toFixed(1) + "%", 1);

    drawMenuFooter("Jog:mode  Knobs:edit  Clk/Bk:back");
}

/* ── Lifecycle ────────────────────────────────────────────────────────────── */
function init() {
    syncFromDSP();
    state.dirty = true;
}

function tick() {
    if (!state.dirty) return;
    state.dirty = false;
    switch (state.view) {
        case "browser":  drawBrowser();  break;
        case "advanced": drawAdvanced(); break;
        default:         drawMain();     break;
    }
}

/* ── Input ────────────────────────────────────────────────────────────────── */
function onMidiMessageInternal(data) {
    if ((data[0] & 0xF0) !== 0xB0) return;
    const cc = data[1], val = data[2];

    /* Back: main→advanced, browser/advanced→main */
    if (cc === MoveBack && val === 127) {
        if (state.view === "main") {
            state.view  = "advanced";
        } else {
            state.view  = "main";
        }
        state.dirty = true;
        return;
    }

    /* jog rotate */
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(val);
        if (delta === 0) return;
        switch (state.view) {
            case "browser":  browserScroll(delta);              break;
            case "advanced": adjustParam("mode", delta);        break;
            default:         adjustParam("sensitivity", delta); break;
        }
        return;
    }

    /* jog click: main→browser, browser→select, advanced→main */
    if (cc === MoveMainButton && val === 127) {
        switch (state.view) {
            case "browser":
                browserSelect();
                break;
            case "advanced":
                state.view  = "main";
                state.dirty = true;
                break;
            default:
                browserOpen(state.browserPath);
                state.view  = "browser";
                state.dirty = true;
                break;
        }
        return;
    }

    /* knobs — main view */
    if (state.view === "main") {
        const delta = decodeDelta(val);
        if (delta === 0) return;
        if      (cc === MoveKnob1) adjustParam("sensitivity", delta);
        else if (cc === MoveKnob2) adjustParam("slices",      delta);
        else if (cc === MoveKnob3) adjustParam("pitch",       delta);
        else if (cc === MoveKnob4) adjustParam("gain",        delta);
        return;
    }

    /* knobs — advanced view */
    if (state.view === "advanced") {
        const delta = decodeDelta(val);
        if (delta === 0) return;
        if      (cc === MoveKnob1) adjustParam("attack",     delta);
        else if (cc === MoveKnob2) adjustParam("decay",      delta);
        else if (cc === MoveKnob3) adjustParam("start_trim", delta);
        else if (cc === MoveKnob4) adjustParam("end_trim",   delta);
        return;
    }
}

/* ── Export ───────────────────────────────────────────────────────────────── */
globalThis.chain_ui = { init, tick, onMidiMessageInternal };
