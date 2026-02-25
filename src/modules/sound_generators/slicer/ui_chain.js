/*
 * Slicer — ui_chain.js v3
 *
 * Layout:
 *   Knobs 1-4 (bank A): Start trim, End trim, Attack, Decay  — per pad
 *   Knobs 5-8 (bank B): Mode, Pitch, Gain, Loop             — 5/6 global, 7/8 per pad
 *
 * Display:
 *   - Sample name always at top
 *   - Default: knobs 1-4 values for selected pad
 *   - Knob touch 1-4: show bank A; touch 5-8: show bank B
 *   - After scan: flash slice count 2s then snap to bank A view
 *
 * Navigation:
 *   - Pad hit: select slice, sync per-pad values, play
 *   - Jog Click: open Browse/Sensitivity overlay (or browser if no sample)
 *   - Jog rotate in overlay: scroll between Browse and Sensitivity
 *   - Jog click in overlay: confirm selection
 *   - Jog rotate in browser: scroll files
 *   - Jog click in browser: select
 *   - Jog rotate in sensitivity: adjust threshold
 *   - Back (CC51): exits chain UI (host behavior, not used here)
 */

import * as os from 'os';
import {
    MoveMainKnob, MoveMainButton, MoveShift, MoveBack,
    MoveKnob1, MoveKnob2, MoveKnob3, MoveKnob4,
    MoveKnob5, MoveKnob6, MoveKnob7, MoveKnob8,
    MoveKnob1Touch, MoveKnob2Touch, MoveKnob3Touch, MoveKnob4Touch,
    MoveKnob5Touch, MoveKnob6Touch, MoveKnob7Touch, MoveKnob8Touch
} from '/data/UserData/move-anything/shared/constants.mjs';
import { decodeDelta } from '/data/UserData/move-anything/shared/input_filter.mjs';

const SAMPLES_DIR = '/data/UserData/UserLibrary/Samples';
const SCREEN_W    = 128;
const SCAN_FLASH_TICKS = 120; /* ~2s at typical tick rate */

const LOOP_LABELS = ['Off', 'Loop', 'Ping'];

/* ── State ───────────────────────────────────────────────────────────────── */
const s = {
    /* views: 'main' | 'browser' | 'overlay' | 'sensitivity' */
    view:    'main',
    knobBank: 'A',       /* 'A' = knobs 1-4, 'B' = knobs 5-8 */
    dirty:   true,

    /* DSP mirror — global */
    sampleName:        '',
    samplePath:        '',
    threshold:         0.5,
    pitch:             0.0,
    mode:              'trigger',
    sliceCountActual:  0,
    slicerState:       0,   /* 0=IDLE 1=READY 2=NO_SLICES */

    /* DSP mirror — per selected pad */
    selectedSlice:     0,
    sliceStartTrim:    0.0,   /* ms */
    sliceEndTrim:      0.0,   /* ms */
    sliceAttack:       5.0,   /* ms */
    sliceDecay:        500.0, /* ms */
    sliceGain:         0.8,
    sliceLoop:         0,     /* 0=off 1=loop 2=pingpong */

    /* scan flash countdown */
    scanFlashTicks:    0,

    /* browser */
    browserPath:       SAMPLES_DIR,
    browserEntries:    [],
    browserCursor:     0,
    browserScroll:     0,

    /* overlay (jog-click menu) */
    overlayCursor:     0,   /* 0=Browse 1=Sensitivity */
};

/* ── DSP helpers ─────────────────────────────────────────────────────────── */
function gp(key, fallback) {
    try { const v = host_module_get_param(key); return v != null ? v : fallback; }
    catch(e) { return fallback; }
}
function sp(key, val) {
    try { host_module_set_param(key, String(val)); } catch(e) {}
}

function syncGlobal() {
    s.samplePath       = gp('sample_path', '');
    s.threshold        = parseFloat(gp('threshold', 0.5));
    s.pitch            = parseFloat(gp('pitch', 0.0));
    s.mode             = gp('mode', 'trigger');
    s.sliceCountActual = parseInt(gp('slice_count_actual', 0));
    s.slicerState      = parseInt(gp('slicer_state', 0));
    s.sampleName       = s.samplePath
        ? s.samplePath.split('/').pop().replace(/\.wav$/i, '')
        : '';
}

function syncPad() {
    sp('selected_slice', s.selectedSlice);
    s.sliceStartTrim = parseFloat(gp('slice_start_trim', 0.0));
    s.sliceEndTrim   = parseFloat(gp('slice_end_trim',   0.0));
    s.sliceAttack    = parseFloat(gp('slice_attack',     5.0));
    s.sliceDecay     = parseFloat(gp('slice_decay',      500.0));
    s.sliceGain      = parseFloat(gp('slice_gain',       0.8));
    s.sliceLoop      = parseInt(gp('slice_loop',         0));
}

function syncAll() {
    syncGlobal();
    syncPad();
    s.dirty = true;
}

/* ── File browser ────────────────────────────────────────────────────────── */
function isDir(path) {
    try {
        const [st, err] = os.stat(path);
        return !err && (st.mode & 0o170000) === 0o040000;
    } catch(e) { return false; }
}

function browserOpen(path) {
    s.browserPath    = path;
    s.browserCursor  = 0;
    s.browserScroll  = 0;
    s.browserEntries = [];
    try {
        const [names, err] = os.readdir(path);
        if (err || !names) return;
        const entries = [];
        if (path !== SAMPLES_DIR) {
            const parts = path.split('/');
            parts.pop();
            entries.push({ name: '..', path: parts.join('/') || '/', dir: true });
        }
        const dirs = [], files = [];
        for (const n of names) {
            if (n === '.' || n === '..') continue;
            const full = path + '/' + n;
            if (isDir(full)) dirs.push({ name: n, path: full, dir: true });
            else if (/\.wav$/i.test(n)) files.push({ name: n, path: full, dir: false });
        }
        dirs.sort((a, b)  => a.name.localeCompare(b.name));
        files.sort((a, b) => a.name.localeCompare(b.name));
        s.browserEntries = entries.concat(dirs, files);
    } catch(e) {}
    s.dirty = true;
}

function browserScrollBy(delta) {
    s.browserCursor = Math.max(0, Math.min(s.browserEntries.length - 1, s.browserCursor + delta));
    if (s.browserCursor < s.browserScroll) s.browserScroll = s.browserCursor;
    else if (s.browserCursor >= s.browserScroll + 4) s.browserScroll = s.browserCursor - 3;
    s.dirty = true;
}

function browserSelect() {
    const e = s.browserEntries[s.browserCursor];
    if (!e) return;
    if (e.dir) {
        browserOpen(e.path);
    } else {
        sp('sample_path', e.path);
        s.samplePath       = e.path;
        s.sampleName       = e.name.replace(/\.wav$/i, '');
        s.slicerState      = 0;
        s.sliceCountActual = 0;
        s.view             = 'main';
        s.dirty            = true;
    }
}

/* ── Param adjusters ─────────────────────────────────────────────────────── */
function fmtMs(v) {
    const sign = v >= 0 ? '+' : '';
    return sign + Math.round(v) + 'ms';
}
function fmtPitch(v) {
    return (v >= 0 ? '+' : '') + v.toFixed(1) + 'st';
}

function adjustStartTrim(delta) {
    s.sliceStartTrim += delta * 5;
    sp('slice_start_trim', s.sliceStartTrim.toFixed(1));
    s.dirty = true;
}
function adjustEndTrim(delta) {
    s.sliceEndTrim += delta * 5;
    sp('slice_end_trim', s.sliceEndTrim.toFixed(1));
    s.dirty = true;
}
function adjustAttack(delta) {
    s.sliceAttack = Math.max(0, Math.min(500, s.sliceAttack + delta * 5));
    sp('slice_attack', s.sliceAttack.toFixed(1));
    s.dirty = true;
}
function adjustDecay(delta) {
    s.sliceDecay = Math.max(0, Math.min(5000, s.sliceDecay + delta * 20));
    sp('slice_decay', s.sliceDecay.toFixed(1));
    s.dirty = true;
}
function adjustMode(delta) {
    s.mode = s.mode === 'trigger' ? 'gate' : 'trigger';
    sp('mode', s.mode);
    s.dirty = true;
}
function adjustPitch(delta) {
    s.pitch = Math.max(-24, Math.min(24, s.pitch + delta * 0.5));
    sp('pitch', s.pitch.toFixed(1));
    s.dirty = true;
}
function adjustGain(delta) {
    s.sliceGain = Math.max(0, Math.min(1, s.sliceGain + delta * 0.05));
    sp('slice_gain', s.sliceGain.toFixed(3));
    s.dirty = true;
}
function adjustLoop(delta) {
    s.sliceLoop = Math.max(0, Math.min(2, s.sliceLoop + (delta > 0 ? 1 : -1)));
    sp('slice_loop', String(s.sliceLoop));
    s.dirty = true;
}
function adjustThreshold(delta) {
    s.threshold = Math.max(0, Math.min(1, s.threshold + delta * 0.05));
    sp('threshold', s.threshold.toFixed(3));
    s.slicerState = 0;
    s.dirty = true;
}

function triggerScan() {
    sp('scan', '1');
}

/* ── Drawing ─────────────────────────────────────────────────────────────── */
function drawSampleName() {
    const name = s.sampleName ? s.sampleName.substring(0, 21) : '-- no sample --';
    print(0, 0, name, 1);
    fill_rect(0, 10, SCREEN_W, 1, 1);
}

function drawBankA() {
    clear_screen();
    drawSampleName();
    const pad = s.slicerState === 1 ? 'Pad ' + (s.selectedSlice + 1) : '---';
    print(0, 13, pad, 1);
    print(0, 23, 'Str:' + fmtMs(s.sliceStartTrim) + '  End:' + fmtMs(s.sliceEndTrim), 1);
    print(0, 33, 'Atk:' + Math.round(s.sliceAttack) + 'ms', 1);
    print(0, 43, 'Dec:' + Math.round(s.sliceDecay) + 'ms', 1);
}

function drawBankB() {
    clear_screen();
    drawSampleName();
    print(0, 13, 'Mode:' + s.mode.toUpperCase(), 1);
    print(0, 23, 'Pitch:' + fmtPitch(s.pitch), 1);
    print(0, 33, 'Gain:' + Math.round(s.sliceGain * 100) + '%', 1);
    print(0, 43, 'Loop:' + LOOP_LABELS[s.sliceLoop], 1);
}

function drawScanFlash() {
    clear_screen();
    drawSampleName();
    print(0, 20, 'Detected:', 1);
    print(0, 32, s.sliceCountActual + ' slices', 1);
}

function drawNoSample() {
    clear_screen();
    drawSampleName();
    print(0, 20, 'Jog: browse', 1);
}

function drawIdle() {
    clear_screen();
    drawSampleName();
    print(0, 20, 'Jog: scan', 1);
    print(0, 32, 'Thresh:' + Math.round(s.threshold * 100) + '%', 1);
}

function drawNoSlices() {
    clear_screen();
    drawSampleName();
    print(0, 20, 'No slices found', 1);
    print(0, 32, 'Lower threshold', 1);
    print(0, 44, 'Jog: adjust/scan', 1);
}

function drawBrowser() {
    clear_screen();
    print(0, 0, 'Browse Samples', 1);
    fill_rect(0, 10, SCREEN_W, 1, 1);
    const visible = s.browserEntries.slice(s.browserScroll, s.browserScroll + 4);
    visible.forEach((e, i) => {
        const idx    = s.browserScroll + i;
        const y      = 14 + i * 12;
        const cursor = idx === s.browserCursor ? '>' : ' ';
        const icon   = e.dir ? '/' : ' ';
        const label  = (cursor + icon + e.name).substring(0, 21);
        print(0, y, label, idx === s.browserCursor ? 2 : 1);
    });
    if (s.browserEntries.length === 0) print(0, 26, 'No WAV files here', 1);
}

function drawOverlay() {
    clear_screen();
    drawSampleName();
    print(0, 18, (s.overlayCursor === 0 ? '> ' : '  ') + 'Browse', 1);
    print(0, 32, (s.overlayCursor === 1 ? '> ' : '  ') + 'Sensitivity', 1);
    print(0, 46, 'Jog:select  Clk:open', 1);
}

function drawSensitivity() {
    clear_screen();
    drawSampleName();
    print(0, 18, 'Sensitivity', 1);
    const barW = Math.round(s.threshold * 100);
    fill_rect(0, 30, barW, 8, 1);
    print(0, 42, Math.round(s.threshold * 100) + '%  Clk:scan', 1);
}

/* ── Tick ─────────────────────────────────────────────────────────────────── */
function tick() {
    const newState = parseInt(gp('slicer_state', 0));
    if (newState !== s.slicerState) {
        s.slicerState      = newState;
        s.sliceCountActual = parseInt(gp('slice_count_actual', 0));
        if (newState === 1) {
            s.scanFlashTicks = SCAN_FLASH_TICKS;
            s.knobBank = 'A';
        }
        s.dirty = true;
    }

    if (s.scanFlashTicks > 0) {
        s.scanFlashTicks--;
        if (s.scanFlashTicks === 0) s.dirty = true;
    }

    if (!s.dirty) return;
    s.dirty = false;

    if (!s.samplePath)            { drawNoSample();    return; }
    if (s.view === 'browser')     { drawBrowser();     return; }
    if (s.view === 'overlay')     { drawOverlay();     return; }
    if (s.view === 'sensitivity') { drawSensitivity(); return; }
    if (s.slicerState === 0)      { drawIdle();        return; }
    if (s.slicerState === 2)      { drawNoSlices();    return; }
    if (s.scanFlashTicks > 0)     { drawScanFlash();   return; }
    if (s.knobBank === 'B')       { drawBankB();       return; }
    drawBankA();
}

/* ── MIDI input ───────────────────────────────────────────────────────────── */
function onMidiMessageInternal(data) {
    const status = data[0] & 0xF0;
    const byte1  = data[1];
    const byte2  = data[2];

    /* ── Note On ── */
    if (status === 0x90 && byte2 > 0) {
        /* pad hit (notes 68-99): select slice */
        if (byte1 >= 68 && byte1 <= 99) {
            if (s.slicerState === 1) {
                const slice = byte1 % s.sliceCountActual;
                if (slice !== s.selectedSlice) {
                    s.selectedSlice = slice;
                    syncPad();
                }
                s.knobBank = 'A';
                s.dirty    = true;
            }
            return;
        }

        /* knob touch: switch display bank */
        const kA = [MoveKnob1Touch, MoveKnob2Touch, MoveKnob3Touch, MoveKnob4Touch];
        const kB = [MoveKnob5Touch, MoveKnob6Touch, MoveKnob7Touch, MoveKnob8Touch];
        if (kA.includes(byte1)) { s.knobBank = 'A'; s.dirty = true; return; }
        if (kB.includes(byte1)) { s.knobBank = 'B'; s.dirty = true; return; }
        return;
    }

    if (status !== 0xB0) return;
    const cc = byte1, val = byte2;

    /* ── Jog rotate ── */
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(val);
        if (s.view === 'browser')     { browserScrollBy(delta); return; }
        if (s.view === 'overlay')     {
            s.overlayCursor = Math.max(0, Math.min(1, s.overlayCursor + (delta > 0 ? 1 : -1)));
            s.dirty = true;
            return;
        }
        if (s.view === 'sensitivity') { adjustThreshold(delta); return; }
        /* main: no sample or IDLE/NO_SLICES → open browser or adjust threshold */
        if (!s.samplePath) {
            browserOpen(s.browserPath);
            s.view  = 'browser';
            s.dirty = true;
            return;
        }
        if (s.slicerState !== 1) { adjustThreshold(delta); return; }
        return;
    }

    /* ── Jog click (val > 0 to handle any non-zero value the hardware sends) ── */
    if (cc === MoveMainButton && val > 0) {
        if (s.view === 'browser') {
            browserSelect();
            return;
        }
        if (s.view === 'overlay') {
            if (s.overlayCursor === 0) {
                browserOpen(s.browserPath);
                s.view = 'browser';
            } else {
                s.view = 'sensitivity';
            }
            s.dirty = true;
            return;
        }
        if (s.view === 'sensitivity') {
            triggerScan();
            s.view  = 'main';
            s.dirty = true;
            return;
        }
        /* main view */
        if (!s.samplePath) {
            browserOpen(s.browserPath);
            s.view  = 'browser';
            s.dirty = true;
            return;
        }
        if (s.slicerState === 1) {
            s.view  = 'overlay';
            s.dirty = true;
        } else {
            triggerScan();
        }
        return;
    }

    /* ── Knobs 1-4 (bank A, per-pad) ── */
    if (cc === MoveKnob1 || cc === MoveKnob2 || cc === MoveKnob3 || cc === MoveKnob4) {
        if (s.slicerState !== 1) return;
        const delta = decodeDelta(val);
        if (cc === MoveKnob1) adjustStartTrim(delta);
        if (cc === MoveKnob2) adjustEndTrim(delta);
        if (cc === MoveKnob3) adjustAttack(delta);
        if (cc === MoveKnob4) adjustDecay(delta);
        return;
    }

    /* ── Knobs 5-8 (bank B) ── */
    if (cc === MoveKnob5 || cc === MoveKnob6 || cc === MoveKnob7 || cc === MoveKnob8) {
        const delta = decodeDelta(val);
        if (cc === MoveKnob5) adjustMode(delta);
        if (cc === MoveKnob6) adjustPitch(delta);
        if (cc === MoveKnob7 && s.slicerState === 1) adjustGain(delta);
        if (cc === MoveKnob8 && s.slicerState === 1) adjustLoop(delta);
        return;
    }
}

/* ── Init ─────────────────────────────────────────────────────────────────── */
function init() {
    syncAll();
    browserOpen(SAMPLES_DIR);
}

/* ── Export ───────────────────────────────────────────────────────────────── */
globalThis.chain_ui = { init, tick, onMidiMessageInternal };
