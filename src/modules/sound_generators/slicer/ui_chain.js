/*
 * Slicer — ui_chain.js v3 (click debug)
 * dbgClick shows last CC9 raw value received — confirm it's firing
 */

import * as os from 'os';
import {
    MoveMainKnob,
    MoveKnob1, MoveKnob2, MoveKnob3, MoveKnob4,
    MoveKnob5, MoveKnob6, MoveKnob7, MoveKnob8
} from '/data/UserData/move-anything/shared/constants.mjs';
import { decodeDelta } from '/data/UserData/move-anything/shared/input_filter.mjs';

const SAMPLES_DIR      = '/data/UserData/UserLibrary/Samples';
const SCREEN_W         = 128;
const SCAN_FLASH_TICKS = 120;
const LOOP_LABELS      = ['Off', 'Loop', 'Ping'];
const JOG_CLICK        = 9;   /* confirmed CC9 on hardware */

let dbgClick = 'none';   /* last raw val seen on CC9 */

const s = {
    view:     'main',
    knobBank: 'A',
    dirty:    true,
    sampleName:       '',
    samplePath:       '',
    threshold:        0.5,
    pitch:            0.0,
    mode:             'trigger',
    sliceCountActual: 0,
    slicerState:      0,
    selectedSlice:    0,
    sliceStartTrim:   0.0,
    sliceEndTrim:     0.0,
    sliceAttack:      5.0,
    sliceDecay:       500.0,
    sliceGain:        0.8,
    sliceLoop:        0,
    scanFlashTicks:   0,
    browserPath:      SAMPLES_DIR,
    browserEntries:   [],
    browserCursor:    0,
    browserScroll:    0,
    overlayCursor:    0,
};

function gp(key, fallback) {
    try { const v = host_module_get_param(key); return v != null ? v : fallback; }
    catch(e) { return fallback; }
}
function sp(key, val) { try { host_module_set_param(key, String(val)); } catch(e) {} }

function syncGlobal() {
    s.samplePath       = gp('sample_path', '');
    s.threshold        = parseFloat(gp('threshold', 0.5));
    s.pitch            = parseFloat(gp('pitch', 0.0));
    s.mode             = gp('mode', 'trigger');
    s.sliceCountActual = parseInt(gp('slice_count_actual', 0));
    s.slicerState      = parseInt(gp('slicer_state', 0));
    s.sampleName       = s.samplePath ? s.samplePath.split('/').pop().replace(/\.wav$/i, '') : '';
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
function syncAll() { syncGlobal(); syncPad(); s.dirty = true; }

function isDir(path) {
    try { const [st, err] = os.stat(path); return !err && (st.mode & 0o170000) === 0o040000; }
    catch(e) { return false; }
}

function browserOpen(path) {
    s.browserPath = path; s.browserCursor = 0; s.browserScroll = 0; s.browserEntries = [];
    try {
        const [names, err] = os.readdir(path);
        if (err || !names) return;
        const entries = [];
        if (path !== SAMPLES_DIR) {
            const parts = path.split('/'); parts.pop();
            entries.push({ name: '..', path: parts.join('/') || '/', dir: true });
        }
        const dirs = [], files = [];
        for (const n of names) {
            if (n === '.' || n === '..') continue;
            const full = path + '/' + n;
            if (isDir(full)) dirs.push({ name: n, path: full, dir: true });
            else if (/\.wav$/i.test(n)) files.push({ name: n, path: full, dir: false });
        }
        dirs.sort((a,b) => a.name.localeCompare(b.name));
        files.sort((a,b) => a.name.localeCompare(b.name));
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
    if (e.dir) { browserOpen(e.path); }
    else {
        sp('sample_path', e.path);
        s.samplePath = e.path; s.sampleName = e.name.replace(/\.wav$/i, '');
        s.slicerState = 0; s.sliceCountActual = 0; s.view = 'main'; s.dirty = true;
    }
}

function fmtMs(v)    { return (v >= 0 ? '+' : '') + Math.round(v) + 'ms'; }
function fmtPitch(v) { return (v >= 0 ? '+' : '') + v.toFixed(1) + 'st'; }

function adjustStartTrim(d) { s.sliceStartTrim += d*5; sp('slice_start_trim', s.sliceStartTrim.toFixed(1)); s.dirty=true; }
function adjustEndTrim(d)   { s.sliceEndTrim   += d*5; sp('slice_end_trim',   s.sliceEndTrim.toFixed(1));   s.dirty=true; }
function adjustAttack(d)    { s.sliceAttack = Math.max(0,Math.min(500,  s.sliceAttack+d*5));  sp('slice_attack', s.sliceAttack.toFixed(1)); s.dirty=true; }
function adjustDecay(d)     { s.sliceDecay  = Math.max(0,Math.min(5000, s.sliceDecay+d*20)); sp('slice_decay',  s.sliceDecay.toFixed(1));  s.dirty=true; }
function adjustMode(d)      { s.mode = s.mode==='trigger'?'gate':'trigger'; sp('mode',s.mode); s.dirty=true; }
function adjustPitch(d)     { s.pitch = Math.max(-24,Math.min(24,s.pitch+d*0.5)); sp('pitch',s.pitch.toFixed(1)); s.dirty=true; }
function adjustGain(d)      { s.sliceGain = Math.max(0,Math.min(1,s.sliceGain+d*0.05)); sp('slice_gain',s.sliceGain.toFixed(3)); s.dirty=true; }
function adjustLoop(d)      { s.sliceLoop = Math.max(0,Math.min(2,s.sliceLoop+(d>0?1:-1))); sp('slice_loop',String(s.sliceLoop)); s.dirty=true; }
function adjustThreshold(d) { s.threshold=Math.max(0,Math.min(1,s.threshold+d*0.05)); sp('threshold',s.threshold.toFixed(3)); s.slicerState=0; s.dirty=true; }
function triggerScan()      { sp('scan','1'); }

function drawSampleName() {
    print(0, 0, (s.sampleName||'-- no sample --').substring(0,21), 1);
    fill_rect(0, 10, SCREEN_W, 1, 1);
}

/* No-sample screen: shows click debug so we can see if CC9 fires at all */
function drawNoSample() {
    clear_screen();
    drawSampleName();
    print(0, 20, 'Jog: browse', 1);
    print(0, 32, 'clk:' + dbgClick, 1);
}

function drawIdle() {
    clear_screen(); drawSampleName();
    print(0, 20, 'Jog click: scan', 1);
    print(0, 32, 'Thresh:' + Math.round(s.threshold*100) + '%', 1);
    print(0, 44, 'Jog: adjust', 1);
}
function drawNoSlices() {
    clear_screen(); drawSampleName();
    print(0, 20, 'No slices found', 1);
    print(0, 32, 'Lower threshold', 1);
    print(0, 44, 'Jog: adjust/scan', 1);
}
function drawScanFlash() {
    clear_screen(); drawSampleName();
    print(0, 20, 'Detected:', 1);
    print(0, 32, s.sliceCountActual + ' slices', 1);
}
function drawBankA() {
    clear_screen(); drawSampleName();
    print(0, 13, s.slicerState===1 ? 'Pad '+(s.selectedSlice+1) : '---', 1);
    print(0, 23, 'Str:'+fmtMs(s.sliceStartTrim)+'  End:'+fmtMs(s.sliceEndTrim), 1);
    print(0, 33, 'Atk:'+Math.round(s.sliceAttack)+'ms', 1);
    print(0, 43, 'Dec:'+Math.round(s.sliceDecay)+'ms', 1);
}
function drawBankB() {
    clear_screen(); drawSampleName();
    print(0, 13, 'Mode:'+s.mode.toUpperCase(), 1);
    print(0, 23, 'Pitch:'+fmtPitch(s.pitch), 1);
    print(0, 33, 'Gain:'+Math.round(s.sliceGain*100)+'%', 1);
    print(0, 43, 'Loop:'+LOOP_LABELS[s.sliceLoop], 1);
}
function drawBrowser() {
    clear_screen();
    print(0, 0, 'Browse Samples', 1);
    fill_rect(0, 10, SCREEN_W, 1, 1);
    s.browserEntries.slice(s.browserScroll, s.browserScroll+4).forEach((e,i) => {
        const idx = s.browserScroll+i;
        print(0, 14+i*12, ((idx===s.browserCursor?'>':' ')+(e.dir?'/':' ')+e.name).substring(0,21), idx===s.browserCursor?2:1);
    });
    if (!s.browserEntries.length) print(0, 26, 'No WAV files here', 1);
}
function drawOverlay() {
    clear_screen(); drawSampleName();
    print(0, 18, (s.overlayCursor===0?'> ':'  ')+'Browse', 1);
    print(0, 32, (s.overlayCursor===1?'> ':'  ')+'Sensitivity', 1);
    print(0, 50, 'Jog:scroll  Clk:select', 1);
}
function drawSensitivity() {
    clear_screen(); drawSampleName();
    print(0, 14, 'Sensitivity', 1);
    fill_rect(0, 26, Math.round(s.threshold*100), 8, 1);
    print(0, 38, Math.round(s.threshold*100)+'%', 1);
    print(0, 50, 'Jog:adjust  Clk:scan', 1);
}

function tick() {
    const newState = parseInt(gp('slicer_state', 0));
    if (newState !== s.slicerState) {
        s.slicerState = newState;
        s.sliceCountActual = parseInt(gp('slice_count_actual', 0));
        if (newState === 1) { s.scanFlashTicks = SCAN_FLASH_TICKS; s.knobBank = 'A'; }
        s.dirty = true;
    }
    if (s.scanFlashTicks > 0) { s.scanFlashTicks--; if (s.scanFlashTicks===0) s.dirty=true; }
    if (!s.dirty) return;
    s.dirty = false;

    if (s.view === 'browser')     { drawBrowser();     return; }
    if (s.view === 'overlay')     { drawOverlay();     return; }
    if (s.view === 'sensitivity') { drawSensitivity(); return; }
    if (!s.samplePath)            { drawNoSample();    return; }
    if (s.slicerState === 0)      { drawIdle();        return; }
    if (s.slicerState === 2)      { drawNoSlices();    return; }
    if (s.scanFlashTicks > 0)     { drawScanFlash();   return; }
    if (s.knobBank === 'B')       { drawBankB();       return; }
    drawBankA();
}

function onMidiMessageInternal(data) {
    const status = data[0] & 0xF0;
    const byte1  = data[1];
    const byte2  = data[2];

    if (status === 0x90 && byte2 > 0 && byte1 >= 68 && byte1 <= 99) {
        if (s.slicerState === 1) {
            const slice = byte1 % s.sliceCountActual;
            if (slice !== s.selectedSlice) { s.selectedSlice = slice; syncPad(); }
            s.knobBank = 'A'; s.dirty = true;
        }
        return;
    }

    if (status !== 0xB0) return;
    const cc = byte1, val = byte2;

    /* Track every CC9 value regardless of handler */
    if (cc === JOG_CLICK) {
        dbgClick = String(val);
        s.dirty = true;
    }

    if (cc === MoveMainKnob) {
        const delta = decodeDelta(val);
        if (s.view === 'browser')     { browserScrollBy(delta); return; }
        if (s.view === 'overlay')     { s.overlayCursor=Math.max(0,Math.min(1,s.overlayCursor+(delta>0?1:-1))); s.dirty=true; return; }
        if (s.view === 'sensitivity') { adjustThreshold(delta); return; }
        if (!s.samplePath) { browserOpen(s.browserPath); s.view='browser'; s.dirty=true; return; }
        if (s.slicerState !== 1) { adjustThreshold(delta); return; }
        return;
    }

    if (cc === JOG_CLICK && val > 0) {
        if (s.view === 'browser')     { browserSelect(); return; }
        if (s.view === 'overlay')     {
            if (s.overlayCursor===0) { browserOpen(s.browserPath); s.view='browser'; }
            else                     { s.view='sensitivity'; }
            s.dirty=true; return;
        }
        if (s.view === 'sensitivity') { triggerScan(); s.view='main'; s.dirty=true; return; }
        if (!s.samplePath) { browserOpen(s.browserPath); s.view='browser'; s.dirty=true; return; }
        if (s.slicerState===1) { s.view='overlay'; s.dirty=true; }
        else                   { triggerScan(); }
        return;
    }

    if (cc===MoveKnob1||cc===MoveKnob2||cc===MoveKnob3||cc===MoveKnob4) {
        s.knobBank='A'; s.dirty=true;
        if (s.slicerState!==1) return;
        const d=decodeDelta(val);
        if (cc===MoveKnob1) adjustStartTrim(d);
        if (cc===MoveKnob2) adjustEndTrim(d);
        if (cc===MoveKnob3) adjustAttack(d);
        if (cc===MoveKnob4) adjustDecay(d);
        return;
    }
    if (cc===MoveKnob5||cc===MoveKnob6||cc===MoveKnob7||cc===MoveKnob8) {
        s.knobBank='B'; s.dirty=true;
        const d=decodeDelta(val);
        if (cc===MoveKnob5) adjustMode(d);
        if (cc===MoveKnob6) adjustPitch(d);
        if (cc===MoveKnob7&&s.slicerState===1) adjustGain(d);
        if (cc===MoveKnob8&&s.slicerState===1) adjustLoop(d);
        return;
    }
}

function init() { syncAll(); browserOpen(SAMPLES_DIR); }

globalThis.chain_ui = { init, tick, onMidiMessageInternal };
