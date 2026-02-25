/*
 * Slicer — ui_chain.js v2
 * State-aware UI: IDLE / READY / NO_SLICES / BROWSER / ADVANCED
 */

import * as os from 'os';
import {
    MoveMainKnob, MoveMainButton, MoveShift, MoveBack,
    MoveKnob1, MoveKnob2, MoveKnob3, MoveKnob4
} from '/data/UserData/move-anything/shared/constants.mjs';
import { decodeDelta } from '/data/UserData/move-anything/shared/input_filter.mjs';

const SAMPLES_DIR = '/data/UserData/UserLibrary/Samples';
const SCREEN_W = 128;
const SCREEN_H = 64;

/* ── State ──────────────────────────────────────────────────────────────── */
const s = {
    view: 'main',        // main | browser | advanced
    shiftHeld: false,
    dirty: true,

    /* DSP mirror */
    sampleName: '',
    samplePath: '',
    threshold: 0.5,
    pitch: 0.0,
    gain: 0.8,
    mode: 'trigger',
    attack: 5.0,
    decay: 200.0,
    startTrim: 0.0,
    endTrim: 1.0,
    sliceCountActual: 0,
    slicerState: 0,      // 0=IDLE 1=READY 2=NO_SLICES

    /* browser */
    browserPath: SAMPLES_DIR,
    browserEntries: [],
    browserCursor: 0,
    browserScroll: 0,
};

/* ── DSP helpers ─────────────────────────────────────────────────────────── */
function gp(key, fallback) {
    try { const v = host_module_get_param(key); return v != null ? v : fallback; }
    catch(e) { return fallback; }
}
function sp(key, val) {
    try { host_module_set_param(key, String(val)); } catch(e) {}
}

function syncFromDSP() {
    s.samplePath       = gp('sample_path', '');
    s.threshold        = parseFloat(gp('threshold', 0.5));
    s.pitch            = parseFloat(gp('pitch', 0.0));
    s.gain             = parseFloat(gp('gain', 0.8));
    s.mode             = gp('mode', 'trigger');
    s.attack           = parseFloat(gp('attack', 5.0));
    s.decay            = parseFloat(gp('decay', 200.0));
    s.startTrim        = parseFloat(gp('start_trim', 0.0));
    s.endTrim          = parseFloat(gp('end_trim', 1.0));
    s.sliceCountActual = parseInt(gp('slice_count_actual', 0));
    s.slicerState      = parseInt(gp('slicer_state', 0));

    if (s.samplePath) {
        const parts = s.samplePath.split('/');
        s.sampleName = parts[parts.length - 1].replace(/\.wav$/i, '');
    } else {
        s.sampleName = '';
    }
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
            if (isDir(full)) {
                dirs.push({ name: n, path: full, dir: true });
            } else if (/\.wav$/i.test(n)) {
                files.push({ name: n, path: full, dir: false });
            }
        }
        dirs.sort((a,b)  => a.name.localeCompare(b.name));
        files.sort((a,b) => a.name.localeCompare(b.name));
        s.browserEntries = entries.concat(dirs, files);
    } catch(e) {}

    s.dirty = true;
}

function browserScroll(delta) {
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
        s.samplePath = e.path;
        s.sampleName = e.name.replace(/\.wav$/i, '');
        s.slicerState = 0;
        s.sliceCountActual = 0;
        s.view = 'main';
        s.dirty = true;
    }
}

/* ── Param adjustment ────────────────────────────────────────────────────── */
function adjust(key, delta) {
    switch(key) {
        case 'threshold':
            s.threshold = Math.max(0, Math.min(1, s.threshold + delta * 0.05));
            sp('threshold', s.threshold.toFixed(3));
            s.slicerState = 0;
            break;
        case 'pitch':
            s.pitch = Math.max(-24, Math.min(24, s.pitch + delta * 0.5));
            sp('pitch', s.pitch.toFixed(1));
            break;
        case 'gain':
            s.gain = Math.max(0, Math.min(1, s.gain + delta * 0.05));
            sp('gain', s.gain.toFixed(3));
            break;
        case 'attack':
            s.attack = Math.max(0, Math.min(500, s.attack + delta * 5));
            sp('attack', s.attack.toFixed(1));
            break;
        case 'decay':
            s.decay = Math.max(0, Math.min(2000, s.decay + delta * 20));
            sp('decay', s.decay.toFixed(1));
            break;
        case 'startTrim':
            s.startTrim = Math.max(0, Math.min(s.endTrim - 0.01, s.startTrim + delta * 0.01));
            sp('start_trim', s.startTrim.toFixed(4));
            s.slicerState = 0;
            break;
        case 'endTrim':
            s.endTrim = Math.max(s.startTrim + 0.01, Math.min(1, s.endTrim + delta * 0.01));
            sp('end_trim', s.endTrim.toFixed(4));
            s.slicerState = 0;
            break;
        case 'mode':
            s.mode = s.mode === 'trigger' ? 'gate' : 'trigger';
            sp('mode', s.mode);
            break;
    }
    s.dirty = true;
}

function triggerScan() {
    sp('scan', '1');
    /* poll DSP state after short delay */
    setTimeout(() => { syncFromDSP(); s.dirty = true; }, 300);
}

/* ── Drawing ─────────────────────────────────────────────────────────────── */
function drawMain() {
    clear_screen();

    /* sample name */
    const name = s.sampleName ? s.sampleName.substring(0, 20) : '-- no sample --';
    print(0, 0, name, 1);

    /* horizontal divider */
    fill_rect(0, 10, SCREEN_W, 1, 1);

    if (!s.samplePath) {
        print(0, 15, 'Clk or Bk: browse', 1);
        return;
    }

    /* threshold */
    const tPct = Math.round(s.threshold * 100);
    print(0, 14, 'Thresh: ' + tPct + '%', 1);

    /* state-specific middle section */
    if (s.slicerState === 1) {
        /* READY */
        print(0, 26, 'Detected: ' + s.sliceCountActual + ' slices', 1);
        print(0, 36, 'Pch:' + (s.pitch >= 0 ? '+' : '') + s.pitch.toFixed(1) +
              '  Gain:' + Math.round(s.gain * 100) + '%', 1);
    } else if (s.slicerState === 2) {
        /* NO SLICES */
        print(0, 26, 'No slices found', 1);
        print(0, 36, 'Lower threshold', 1);
    } else {
        /* IDLE */
        print(0, 26, 'Clk: scan', 1);
    }

    /* footer */
    fill_rect(0, 54, SCREEN_W, 1, 1);
    print(0, 56, 'Bk:browse  Clk:adv', 1);
}

function drawAdvanced() {
    clear_screen();
    print(0, 0, '-- Advanced --', 1);
    fill_rect(0, 10, SCREEN_W, 1, 1);
    print(0, 14, 'Mode: ' + s.mode.toUpperCase(), 1);
    print(0, 24, 'Atk:' + Math.round(s.attack) + 'ms  Dec:' + Math.round(s.decay) + 'ms', 1);
    print(0, 34, 'Start:' + Math.round(s.startTrim * 100) + '%  End:' + Math.round(s.endTrim * 100) + '%', 1);
    fill_rect(0, 54, SCREEN_W, 1, 1);
    print(0, 56, 'Jog:mode  Back:main', 1);
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

    if (s.browserEntries.length === 0) {
        print(0, 26, 'No WAV files here', 1);
    }

    fill_rect(0, 54, SCREEN_W, 1, 1);
    print(0, 56, 'Jog:scroll  Clk:select', 1);
}

/* ── Tick ────────────────────────────────────────────────────────────────── */
function tick() {
    /* poll DSP state every tick when scanning */
    if (s.slicerState === 0 && s.samplePath) {
        const newState = parseInt(gp('slicer_state', 0));
        if (newState !== s.slicerState) {
            s.slicerState      = newState;
            s.sliceCountActual = parseInt(gp('slice_count_actual', 0));
            s.dirty = true;
        }
    }

    if (!s.dirty) return;
    s.dirty = false;

    switch(s.view) {
        case 'browser':  drawBrowser();  break;
        case 'advanced': drawAdvanced(); break;
        default:         drawMain();     break;
    }
}

/* ── MIDI input ──────────────────────────────────────────────────────────── */
function onMidiMessageInternal(data) {
    if ((data[0] & 0xF0) !== 0xB0) return;
    const cc = data[1], val = data[2];

    /* shift tracking */
    if (cc === MoveShift) { s.shiftHeld = val > 0; return; }

    /* back: main→browser, browser/advanced→main */
    if (cc === MoveBack && val === 127) {
        if (s.view === 'main') {
            browserOpen(s.browserPath);
            s.view = 'browser';
        } else {
            s.view = 'main';
        }
        s.dirty = true;
        return;
    }

    /* jog rotate */
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(val);
        if (s.view === 'browser') {
            browserScroll(delta);
        } else if (s.view === 'advanced') {
            adjust('mode', delta);
        } else {
            adjust('threshold', delta);
        }
        return;
    }

    /* jog click */
    if (cc === MoveMainButton && val === 127) {
        if (s.shiftHeld) {
            /* Shift+Jog → toggle browser */
            if (s.view === 'browser') {
                s.view = 'main';
            } else {
                browserOpen(s.browserPath);
                s.view = 'browser';
            }
            s.dirty = true;
            return;
        }

        switch(s.view) {
            case 'browser':
                browserSelect();
                break;
            case 'advanced':
                s.view = 'main';
                s.dirty = true;
                break;
            default:
                /* main: no sample → browser, idle/no_slices → scan, ready → advanced */
                if (!s.samplePath) {
                    browserOpen(s.browserPath);
                    s.view = 'browser';
                    s.dirty = true;
                } else if (s.slicerState !== 1) {
                    triggerScan();
                } else {
                    s.view = 'advanced';
                    s.dirty = true;
                }
                break;
        }
        return;
    }

    /* knobs — main view */
    if (s.view === 'main') {
        const delta = decodeDelta(val);
        if      (cc === MoveKnob1) adjust('threshold', delta);
        else if (cc === MoveKnob2) adjust('pitch',     delta);
        else if (cc === MoveKnob3) adjust('gain',      delta);
    }

    /* knobs — advanced view */
    if (s.view === 'advanced') {
        const delta = decodeDelta(val);
        if      (cc === MoveKnob1) adjust('attack',    delta);
        else if (cc === MoveKnob2) adjust('decay',     delta);
        else if (cc === MoveKnob3) adjust('startTrim', delta);
        else if (cc === MoveKnob4) adjust('endTrim',   delta);
    }
}

/* ── Init ────────────────────────────────────────────────────────────────── */
function init() {
    syncFromDSP();
    browserOpen(SAMPLES_DIR);
}

/* ── Export ──────────────────────────────────────────────────────────────── */
globalThis.chain_ui = { init, tick, onMidiMessageInternal };
