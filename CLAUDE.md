# move-anything — Project Context

## End of Session Command

update CLAUDE.md with everything we built or changed today, current status of all open issues, and updated next steps — then run: git add -A && git commit -m "WIP: end of session snapshot" && git push origin main

## What This Is
Fork of charlesvestal/move-anything. Primary work: a custom **Slicer** sound generator module that runs on Ableton Move hardware (ARM64 Linux) using Plugin API v2 + QuickJS UI.

## Upstream / Fork
- Original: https://github.com/charlesvestal/move-anything
- My fork: https://github.com/j3threejay/move-anything (SSH remote: `git@github.com:j3threejay/move-anything.git`)

## What We've Built

### Slicer Module — `src/modules/sound_generators/slicer/`
A transient-detection sampler with up to 128 auto-slices, polyphonic playback, A/D envelope, and WAV file browser.

**Files:**
- `dsp.c` — Plugin API v2 C DSP: WAV loader (16/24-bit PCM, proper RIFF chunk scanning), energy-based RMS transient detection, 8-voice polyphony, linear interpolation playback
- `ui_chain.js` — Signal Chain UI shim v2 (QuickJS ES module): state machine (IDLE/READY/NO_SLICES), file browser, param display, explicit scan trigger
- `module.json` — `"name": "Slicer"`, `"api_version": 2`, `"component_type": "sound_generator"`, `"chainable": true`

**DSP params exposed:**
`threshold` (0–1), `slices` (8/16/32/64/128), `pitch` (±24 semitones), `gain`, `mode` (trigger/gate), `attack` (0–500ms), `decay` (0–2000ms), `start_trim`, `end_trim`, `sample_path`, `slice_count_actual` (read-only), `slicer_state` (read-only: 0=IDLE/1=READY/2=NO_SLICES), `scan` (write: triggers detection)

**UI state machine:**
- **IDLE**: sample loaded, not yet scanned → Jog Click triggers scan
- **READY**: slices detected → shows slice count, Jog Click goes to advanced
- **NO_SLICES**: scan ran but found nothing → prompt to lower threshold

**UI navigation (shift unavailable — CC49 consumed by shim):**

| Input | Main (no sample) | Main (IDLE/NO_SLICES) | Main (READY) | Browser | Advanced |
|---|---|---|---|---|---|
| Jog Click | → browser | → scan | → advanced | select/enter | → main |
| Back | → browser | → browser | → browser | → main | → main |
| Jog rotate | — | adjust threshold | adjust threshold | scroll | cycle mode |
| Knobs 1–4 | — | threshold/pitch/gain/— | threshold/pitch/gain/— | — | attack/decay/start/end |

**File browser implementation:**
`import * as os from 'os'` — `os.readdir([names, err])` + `os.stat([stat, err])` with `(st.mode & 0o170000) === 0o040000` for dir detection. Root: `/data/UserData/UserLibrary/Samples`. Confirmed working on device.

**`setTimeout` note:** `triggerScan()` calls `setTimeout(..., 300)` for a post-scan sync. QuickJS may not have `setTimeout` — if scan click produces no UI update, this is why. The `tick()` poll will still pick up state changes from DSP.

### Deploy Script — `scripts/deploy-slicer.sh`
Cross-compiles `dsp.c` via Docker, SCPs `dsp.so + module.json + ui_chain.js`, restarts service.

```bash
./scripts/deploy-slicer.sh                          # uses move.local
MOVE_HOST=172.16.254.1 ./scripts/deploy-slicer.sh  # override with USB IP (most reliable)
```

If deploy-slicer.sh SSH step times out (known intermittent issue), deploy manually:
```bash
DEST="/data/UserData/move-anything/modules/sound_generators/slicer"
SRC="src/modules/sound_generators/slicer"
OUT="build/modules/sound_generators/slicer"
scp -o ConnectTimeout=10 -o StrictHostKeyChecking=no "$OUT/dsp.so" "$SRC/module.json" "$SRC/ui_chain.js" "ableton@172.16.254.1:$DEST/" && \
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -n root@172.16.254.1 "/etc/init.d/move stop; sleep 1; /etc/init.d/move start"
```

SSH users: `ableton@<ip>` (file ops), `root@<ip>` (service restart)

### build.sh additions
`scripts/build.sh` cross-compiles `src/modules/sound_generators/slicer/dsp.c` → `build/modules/sound_generators/slicer/dsp.so`.

## SSH / Deploy Requirements
- Move on WiFi, SSH key added at http://move.local/development/ssh
- Both devices on same network
- Docker installed (for cross-compilation)
- `install.sh local` requires interactive TTY — run directly in terminal, not via script
- `move.local` mDNS sometimes flaky — use IP `192.168.68.62` if hostname fails

## Accessing Slicer on Move
Shadow UI → Sound Generators → Slicer → add to Signal Chain

## Debug Logging
Enable: `ssh ableton@move.local 'touch /data/UserData/move-anything/debug_log_on'`
Watch: `ssh ableton@move.local 'tail -f /data/UserData/move-anything/debug.log'`

Key log components: `[shim]`, `[shadow]`, `[shadow_ui]`, `[chain]`, `[chain-v2]`

## MIDI Routing in ui_chain.js — Critical Notes
- **CC 49 (Shift) is consumed by the shim** — never reaches JS. `shiftHeld` will always be false in ui_chain.js. Do not design any feature around shift state.
- **chain/ui.js** only intercepts `Shift+Menu` (CC50) when `componentUiActive`. Everything else passes to `componentUi.onMidiMessageInternal(data)`.
- **CC 50 (Menu)** — exits to session view above chain/ui.js. Never use as trigger.
- **CC 51 (Back)** — reaches ui_chain.js cleanly.
- **CC 3 (Jog Click), CC 14 (Jog rotate), CC 71–74 (Knobs 1–4)** — all pass through cleanly.

## Bugs Fixed
- **WAV JUNK chunk**: Pro WAVs have a `JUNK` chunk before `fmt `. Old 44-byte flat reader → `channels=0` → silence. Fixed with proper RIFF chunk scanner.
- **24-bit WAV**: Added support — reads 3 bytes/sample, shifts to 16-bit.
- **Shift+Jog browser trigger**: Shim consumes CC49. Redesigned navigation to use plain Jog Click and Back (no shift needed).
- **Auto-detect on load removed**: DSP now stays IDLE until `scan=1` is set explicitly.
- **`sensitivity` renamed `threshold`**: Matches UI intent.
- **render_block out-of-bounds read**: Bounds check now runs before any sample access using strict `>= slice_end`. Interpolation lookahead `pos_next` clamps to `pos_int`.
- **voice_start slice clamps**: `start < 0` and `end > sample_frames` both guarded.
- **`int32_t pos` overflow**: Fixed — changed to `int64_t`. `int32_t` could only represent ~0.74s of audio; any slice past that overflowed to negative, reading backward into unrelated memory (major distortion source, especially on hi-hats/cymbals which sit later in loops).
- **Per-voice int16 clipping in mixer**: Replaced read-back-and-clamp-per-voice with a float `mix_l[]/mix_r[]` accumulation buffer. Single `clamp16()` pass at end of block.
- **Voice stealing without zeroing state**: `find_free_voice()` now `memset`s stolen voice before reuse.
- **ENV_IDLE not zeroing env_val**: Added hard zero + break at top of inner loop.
- **Same-note comb filtering on retrigger**: `voice_start` now steals the existing same-note voice (memset + reuse) before falling back to `find_free_voice`. Prevents overlapping decays of identical slices creating metallic resonance.
- **End-of-slice hard cutoff causing tin-can ringing**: Replaced immediate `active=0` at slice end with a 64-sample (~1.5ms) linear release fade. Voice holds last frame at decaying amplitude until the countdown reaches zero.
- **Back button exits chain UI**: `MoveBack` (CC51) is intercepted by the chain host and exits the component — cannot be used for in-component navigation.
- **Attack/decay coefficients swapped in render_block**: `ENV_ATTACK` was using `v->env_attack` and `ENV_DECAY` was using `v->env_decay` — behavior was inverted on hardware. Fixed by swapping: `ENV_ATTACK` now uses `v->env_decay` and `ENV_DECAY` uses `v->env_attack` in the render loop.
- **Browser hover preview never fired**: `sp('preview_path', ...)` was only called from `browserScrollBy` — cursor position 0 on open never triggered audio. Fixed by firing preview for entry[0] at end of `browserOpen`.
- **Note mapping comment mismatch fixed**: ui_chain.js top-of-file comment now correctly reflects pad mapping (note-68, 0-31) matching DSP.

## Navigation — Final Design
- **Back (CC51)**: exits chain UI entirely — do NOT use for in-component navigation
- **Shift (CC49)**: consumed by shim — never reaches JS
- **Knob 4 tap (Note 3, MoveKnob4Touch)**: opens browser from main view
- **Jog Click in advanced**: opens browser
- **Jog Click in browser**: select file / enter folder → returns to main on file select
- **Jog Click in main (no sample)**: opens browser
- **Jog Click in main (IDLE/NO_SLICES)**: triggers scan
- **Jog Click in main (READY)**: opens advanced

## Knob Touch Events
Knob caps have capacitive touch sensors: MIDI Note On (notes 0–3 for knobs 1–4), velocity 127 = touched. These reach `onMidiMessageInternal` — `onMidiMessageInternal` must handle both `0x90` (Note On) and `0xB0` (CC) status bytes.

## Move IP Notes
- Move's IP can change between sessions. Use `ping move.local` to discover current IP.
- mDNS `move.local` resolves but SCP/SSH may need `-o StrictHostKeyChecking=no` if IP changed.
- Last known IP: `172.16.254.1` (USB network interface, stable) — prefer this over WiFi IP.

## Note → Slice Mapping (current design)
- **Move pads (notes 68–99)**: `slice_idx = note - 68` → slices 0–31 (direct pad mapping, both DSP and UI)
- **All other notes**: `slice_idx = note - 36` (chromatic from C2)
- Notes outside `[0, slice_count_actual)` are silently ignored in DSP and UI
- Design tension: notes 36–67 AND pads 68–99 both address slices 0–31 (overlap). Slices 32–63 unreachable unless >32 slices and using chromatic notes. Accepted trade-off: pads must work for typical drum loops (8–32 slices).

## Current Status (end of session)
- ✅ File browser: working — navigates subdirs, selects WAV
- ✅ WAV loading: JUNK-chunk + 24-bit PCM support
- ✅ State machine UI: IDLE/READY/NO_SLICES flow
- ✅ Explicit scan trigger: Jog Click → `scan=1` → DSP detects → state updates
- ✅ render_block fully safe: int64 pos, float mix buffer, bounds check before read, release fade
- ✅ Voice stealing: same-note steal + memset on free-voice steal
- ✅ Browser navigation: Knob 4 tap (main) + Jog Click (advanced) both open browser
- ✅ Attack/decay swap fixed: ENV_ATTACK uses env_decay coeff, ENV_DECAY uses env_attack coeff
- ✅ Browser hover preview: fires on open (entry[0]) and on scroll — confirmed working on device
- ⏳ **Per-pad params: STILL NOT WORKING on device** — pad hits don't update selectedSlice display or knob targets; root cause not yet found (DSP and UI mapping are consistent, `selected_slice` param write path appears correct, unknown if `host_module_set_param` call is reaching DSP in this context)
- ⏳ Attack/decay defaults and feel: decay 0ms default needs revisiting; low-ms decay tail choppy
- ⏳ Transient detection quality: needs testing with real drum loops
- ⏳ Shadow UI param editing (ui_hierarchy / chain_params): not implemented

## Next Steps
- [ ] **Debug per-pad params**: add `fprintf(stderr, ...)` to `v2_set_param` for `selected_slice` and `slice_attack` to confirm DSP is receiving writes; watch with `ssh ableton@172.16.254.1 'tail -f /data/UserData/move-anything/debug.log'`; also log in JS `selectSlice()` to confirm it's being called
- [ ] Once per-pad confirmed working: test knob 1-4 edits (attack/decay/start/end) update per-slice and take effect on next trigger
- [ ] Fix attack/decay defaults: set decay default to max (full sustain feel); smooth low-ms decay tail
- [ ] Test transient detection quality with real drum loops — tune threshold range if needed
- [ ] Consider exposing `ui_hierarchy` + `chain_params` for Shadow UI knob mapping

---

# CLAUDE.md

Instructions for Claude Code when working with this repository.

## Project Overview

Move Anything is a framework for custom JavaScript and native DSP modules on Ableton Move hardware. It provides access to pads, encoders, buttons, display (128x64 1-bit), audio I/O, and MIDI via USB-A.

## Build Commands

```bash
./scripts/build.sh           # Build with Docker (auto-detects, recommended)
./scripts/package.sh         # Create move-anything.tar.gz
./scripts/clean.sh           # Remove build/ and dist/
./scripts/install.sh         # Deploy from GitHub release
./scripts/install.sh local   # Deploy from local build
./scripts/uninstall.sh       # Restore stock Move
```

Cross-compilation uses `${CROSS_PREFIX}gcc` for the Move's ARM architecture.

## Architecture

### Host + Module System

```
Host (move-anything):
  - Owns /dev/ablspi0.0 for hardware communication
  - Embeds QuickJS for JavaScript execution
  - Manages module discovery and lifecycle
  - Routes MIDI to JS UI and DSP plugin

Modules (src/modules/<id>/):
  - module.json: metadata
  - ui.js: JavaScript UI (init, tick, onMidiMessage*)
  - ui_chain.js: optional Signal Chain UI shim
  - dsp.so: optional native DSP plugin
```

### Key Source Files

- **src/move_anything.c**: Main host runtime
- **src/move_anything_shim.c**: LD_PRELOAD shim
- **src/host/plugin_api_v1.h**: DSP plugin C API
- **src/host/module_manager.c**: Module loading
- **src/host/menu_ui.js**: Host menu for module selection

### Module Structure

```
src/modules/<id>/
  module.json       # Required - metadata and capabilities
  ui.js             # JavaScript UI
  dsp.so            # Optional native DSP plugin
```

Built-in modules (in main repo):
- `chain` - Signal Chain for combining components
- `controller` - MIDI Controller with 16 banks
- `store` - Module Store for downloading external modules

### Module Categorization

Modules declare their category via `component_type` in module.json:

```json
{
    "id": "my-module",
    "name": "My Module",
    "component_type": "sound_generator"
}
```

Valid component types:
- `featured` - Featured modules (Signal Chain), shown first
- `sound_generator` - Synths and samplers
- `audio_fx` - Audio effects
- `midi_fx` - MIDI processors
- `utility` - Utility modules
- `overtake` - Overtake modules (full UI control in shadow mode)
- `system` - System modules (Module Store), shown last

The main menu automatically organizes modules by category, reading from each module's `component_type` field.

### Plugin API v2 (Recommended)

V2 supports multiple instances and is required for Signal Chain integration:

```c
typedef struct plugin_api_v2 {
    uint32_t api_version;              // Must be 2
    void* (*create_instance)(const char *module_dir, const char *json_defaults);
    void (*destroy_instance)(void *instance);
    void (*on_midi)(void *instance, const uint8_t *msg, int len, int source);
    void (*set_param)(void *instance, const char *key, const char *val);
    int (*get_param)(void *instance, const char *key, char *buf, int buf_len);
    void (*render_block)(void *instance, int16_t *out_lr, int frames);
} plugin_api_v2_t;

// Entry point
extern "C" plugin_api_v2_t* move_plugin_init_v2(const host_api_v1_t *host);
```

### Plugin API v1 (Deprecated)

V1 is a singleton API - only one instance can exist. Do not use for new modules:

```c
typedef struct plugin_api_v1 {
    uint32_t api_version;
    int (*on_load)(const char *module_dir, const char *json_defaults);
    void (*on_unload)(void);
    void (*on_midi)(const uint8_t *msg, int len, int source);
    void (*set_param)(const char *key, const char *val);
    int (*get_param)(const char *key, char *buf, int buf_len);
    void (*render_block)(int16_t *out_interleaved_lr, int frames);
} plugin_api_v1_t;
```

Audio: 44100 Hz, 128 frames/block, stereo interleaved int16.

### JS Host Functions

```javascript
// Module management
host_list_modules()           // -> [{id, name, version, component_type}, ...]
host_load_module(id_or_index)
host_load_ui_module(path)
host_unload_module()
host_return_to_menu()
host_module_set_param(key, val)
host_module_get_param(key)
host_module_send_midi(msg, source)
host_is_module_loaded()
host_get_current_module()
host_rescan_modules()

// Host volume control
host_get_volume()             // -> int (0-100)
host_set_volume(vol)          // set host volume

// Host input settings
host_get_setting(key)         // -> value (velocity_curve, aftertouch_enabled, aftertouch_deadzone)
host_set_setting(key, val)    // set setting
host_save_settings()          // persist to disk
host_reload_settings()        // reload from disk

// Display control
host_flush_display()          // Force immediate display update
host_set_refresh_rate(hz)     // Set display refresh rate
host_get_refresh_rate()       // Get current refresh rate

// File system utilities (used by Module Store)
host_file_exists(path)        // -> bool
host_read_file(path)          // -> string or null
host_http_download(url, dest) // -> bool
host_extract_tar(tarball, dir) // -> bool
host_remove_dir(path)         // -> bool
```

### Host Volume Control

The volume knob (CC 79) controls host-level output volume by default. Volume is applied after module DSP rendering but before audio output.

Modules can claim the volume knob for their own use by setting `"claims_master_knob": true` in their module.json capabilities section. When claimed, the host passes the CC through to the module instead of adjusting volume.

### Shared JS Utilities

Located in `src/shared/`:
- `constants.mjs` - MIDI CC/note mappings
- `input_filter.mjs` - Capacitive touch filtering
- `midi_messages.mjs` - MIDI helpers
- `move_display.mjs` - Display utilities
- `menu_layout.mjs` - Title/list/footer menu layout helpers
- `store_utils.mjs` - Module Store catalog fetching and install/remove functions

## Move Hardware MIDI

Pads: Notes 68-99
Steps: Notes 16-31
Tracks: CCs 40-43 (reversed: CC43=Track1, CC40=Track4)

Key CCs: 3 (jog click), 14 (jog turn), 49 (shift), 50 (menu), 51 (back), 71-78 (knobs)

Notes 0-9: Capacitive touch from knobs (filter if not needed)

## Audio Mailbox Layout

```
AUDIO_OUT_OFFSET = 256
AUDIO_IN_OFFSET  = 2304
AUDIO_BYTES_PER_BLOCK = 512
FRAMES_PER_BLOCK = 128
SAMPLE_RATE = 44100
```

Frame layout: [L0, R0, L1, R1, ..., L127, R127] as int16 little-endian.

## Deployment

On-device layout:
```
/data/UserData/move-anything/
  move-anything               # Host binary
  move-anything-shim.so       # Shim (also at /usr/lib/)
  host/menu_ui.js
  shared/
  modules/
    chain/, controller/, store/     # Built-in modules (root level)
    sound_generators/<id>/          # External sound generators
    audio_fx/<id>/                  # External audio effects
    midi_fx/<id>/                   # External MIDI effects
```

External modules are installed to category subdirectories based on their `component_type`.

Original Move preserved as `/opt/move/MoveOriginal`.

## Signal Chain Module

The `chain` module implements a modular signal chain for combining components:

```
[Input or MIDI Source] → [MIDI FX] → [Sound Generator] → [Audio FX] → [Output]
```

### Module Capabilities for Chaining

Modules declare chainability in module.json:
```json
{
    "capabilities": {
        "chainable": true,
        "component_type": "sound_generator"
    }
}
```

Component types: `sound_generator`, `audio_fx`, `midi_fx`

### Shadow UI Parameter Hierarchy

Modules expose parameters to the Shadow UI via `ui_hierarchy` in their get_param response. The hierarchy defines menu structure, knob mappings, and navigation.

**Structure:**
```json
{
  "modes": null,
  "levels": {
    "root": {
      "label": "SF2",
      "list_param": "preset",
      "count_param": "preset_count",
      "name_param": "preset_name",
      "children": null,
      "knobs": ["octave_transpose", "gain"],
      "params": [
        {"key": "octave_transpose", "label": "Octave"},
        {"key": "gain", "label": "Gain"},
        {"level": "soundfont", "label": "Choose Soundfont"}
      ]
    },
    "soundfont": {
      "label": "Soundfont",
      "items_param": "soundfont_list",
      "select_param": "soundfont_index",
      "children": null,
      "knobs": [],
      "params": []
    }
  }
}
```

**Key fields:**

- `knobs`: Array of **strings** (parameter keys) mapped to physical knobs 1-8
- `params`: Array for menu items. Each entry is either:
  - **String**: Parameter key (e.g., `"gain"`)
  - **Editable param object**: `{"key": "gain", "label": "Gain"}`
  - **Navigation object**: `{"level": "soundfont", "label": "Choose Soundfont"}`
- `list_param`/`count_param`/`name_param`: For preset browser levels
- `items_param`/`select_param`: For dynamic item selection levels

**Important:** Use `key` (not `param`) for editable parameter objects. Metadata (type, min, max) comes from `chain_params`.

### Chain Parameters

Modules expose parameter metadata via `chain_params` in their get_param response. This is **required** for the Shadow UI to properly edit parameters (with correct step sizes, ranges, and enum options):

```c
if (strcmp(key, "chain_params") == 0) {
    const char *json = "["
        "{\"key\":\"cutoff\",\"name\":\"Cutoff\",\"type\":\"float\",\"min\":0,\"max\":1,\"step\":0.01},"
        "{\"key\":\"mode\",\"name\":\"Mode\",\"type\":\"enum\",\"options\":[\"LP\",\"HP\",\"BP\"]}"
    "]";
    strcpy(buf, json);
    return strlen(json);
}
```

Parameter types: `float` (with `min`, `max`, `step`), `int` (with `min`, `max`), `enum` (with `options` array).
Optional fields: `default`, `unit`, `display_format`.

These provide metadata for the Shadow UI parameter editor alongside `ui_hierarchy` (which defines menu structure and knob mappings).

### Chain Architecture

- Chain host (`modules/chain/dsp/chain_host.c`) loads sub-plugins via dlopen
- Forwards MIDI to sound generator, routes audio through effects
- Patch files stored in `/data/UserData/move-anything/patches/*.json` on device define chain configurations
- MIDI FX: chord generator, arpeggiator (up, down, up_down, random)
- Audio FX: freeverb
- MIDI sources (optional): DSP modules that generate MIDI; can provide `ui_chain.js` for full-screen chain UI

### Recording

Signal Chain supports recording audio output to WAV files:

- **Record Button** (CC 118): Toggles recording on/off
- **LED States**: Off (no patch), White (patch loaded), Red (recording)
- **Output**: Recordings saved to `/data/UserData/move-anything/recordings/rec_YYYYMMDD_HHMMSS.wav`
- **Format**: 44.1kHz, 16-bit stereo WAV

Recording uses a background thread with a 2-second ring buffer to prevent audio dropouts during disk I/O. Recording requires a patch to be loaded.

### External Modules

External modules are maintained in separate repositories and available via Module Store:

**Sound Generators:**
- `braids` - Mutable Instruments macro oscillator (47 algorithms)
- `rings` - Mutable Instruments resonator
- `sf2` - SoundFont synthesizer (TinySoundFont)
- `dexed` - 6-operator FM synthesizer (Dexed/MSFA)
- `minijv` - ROM-based PCM rompler emulator
- `obxd` - Oberheim OB-X emulator
- `clap` - CLAP plugin host

**Audio FX:**
- `cloudseed` - Algorithmic reverb
- `psxverb` - PlayStation SPU reverb
- `tapescam` - Tape saturation
- `tapedelay` - Tape delay with flutter and saturation

**Utilities/Overtake:**
- `m8` - Dirtywave M8 Launchpad Pro emulator
- `sidcontrol` - SID Control for SIDaster III
- `controller` - MIDI Controller with 16 banks (built-in)

External modules install their own Signal Chain presets via their install scripts.

## Shadow Mode

Shadow Mode runs custom signal chains alongside stock Move. The shim intercepts hardware I/O to mix shadow audio with Move's output.

### Shadow Mode Shortcuts

- **Shift+Vol+Track 1-4**: Open shadow mode / jump to slot settings (works from Move or Shadow UI)
- **Shift+Vol+Menu**: Jump directly to Master FX settings
- **Shift+Vol+Step2**: Open Global Settings
- **Shift+Vol+Jog Click**: Exit overtake module (when in overtake mode)

### Quantized Sampler

- Shift+Sample opens the sampler
- Choose source: resample (including Move Everything synths), or Move Input (whatever is set in the regular sample flow)
- Choose duration in bars (or until stopped). Uses MIDI clock to determine tempo, falling back to project tempo if not found.
- Starts on a note event or pressing play
- Recordings are saved to `Samples/Move Everything/`

Works for resampling your Move, including Move Everything synths, or a line-in source or microphone. You can use Move's built-in count-in for line-in recordings too.

### Skipback

Shift+Capture writes the last 30 seconds of audio to disk. Uses the same source as the quantized sampler (resample or Move Input). Saved to `Samples/Move Everything/Skipback/`.

### Shadow Architecture

```
src/move_anything_shim.c    # LD_PRELOAD shim - intercepts ioctl, mixes audio
src/shadow/shadow_ui.js     # Shadow UI - slot/patch management
src/host/shadow_constants.h # Shared memory structures
```

Key shared memory segments:
- `/move-shadow-audio` - Shadow's mixed audio output
- `/move-shadow-control` - Control flags and state (shadow_control_t)
- `/move-shadow-param` - Parameter get/set requests (shadow_param_t)
- `/move-shadow-ui` - UI state for slot info (shadow_ui_state_t)

### Shadow UI Flags

Communication between shim and Shadow UI uses flags in `shadow_control_t.ui_flags`:
- `SHADOW_UI_FLAG_JUMP_TO_SLOT (0x01)` - Jump to slot settings on open
- `SHADOW_UI_FLAG_JUMP_TO_MASTER_FX (0x02)` - Jump to Master FX on open
- `SHADOW_UI_FLAG_JUMP_TO_OVERTAKE (0x04)` - Jump to overtake module menu

### Shadow Slot Features

Each of the 4 shadow slots has:
- **Receive channel**: MIDI channel to listen on (default 1-4)
- **Forward channel**: Remap MIDI to specific channel for synths that require it (-1 = auto/passthrough)
- **Volume**: Per-slot volume control
- **State persistence**: Synth, audio FX, and MIDI FX states saved/restored automatically

### MIDI Cable Filtering

The shim filters MIDI by USB cable number in the hardware MIDI buffers:

**MIDI_IN buffer (offset 2048):**
- Cable 0: Internal Move hardware controls (pads, knobs, buttons)
- Cable 2: External USB MIDI input (devices connected to Move's USB-A port)

**MIDI_OUT buffer (offset 0):**
- Cable 0: Move's internal MIDI output
- Cable 2: External USB MIDI output

**Routing rules:**
- Normal shadow mode: Only cable 0 (internal controls) is processed
- Overtake mode: All cables are forwarded, including external USB MIDI (cable 2)
- External MIDI from cable 2 is routed to `onMidiMessageExternal` in overtake modules

**Important:** If Move tracks are configured to listen and output on the same MIDI channel, external MIDI may be echoed back. Configure Move tracks to use different channels than your external device to avoid interference.

### Master FX Chain

Shadow mode includes a 4-slot Master FX chain that processes mixed output from all shadow slots. Access via Shift+Vol+Menu.

### Overtake Modules

Overtake modules take complete control of Move's UI in shadow mode. They're accessed via the shadow UI's "Overtake Modules" menu.

**Module Requirements:**
- Set `"component_type": "overtake"` in module.json
- Use progressive LED initialization (buffer holds ~64 packets)
- Handle all MIDI input via `onMidiMessageInternal`/`onMidiMessageExternal`

**Lifecycle:**
1. Host clears all LEDs progressively (shows "Loading...")
2. ~500ms delay before calling module's `init()`
3. Module runs with full UI control
4. Shift+Vol+Jog Click triggers exit (host-level, always works)
5. Host clears LEDs progressively (shows "Exiting...")
6. Returns to Move

**LED Buffer Constraint:**
The MIDI output buffer holds ~64 USB-MIDI packets. Sending more than 60 LED commands per frame causes overflow. Use progressive LED initialization:

```javascript
const LEDS_PER_FRAME = 8;
let ledInitPending = true;
let ledInitIndex = 0;

globalThis.tick = function() {
    if (ledInitPending) {
        // Set 8 LEDs per frame
        setupLedBatch();
    }
    drawUI();
};
```

**Key Files:**
- `src/shadow/shadow_ui.js` - Overtake module loading and lifecycle
- `src/modules/controller/ui.js` - Example overtake module

**External Device Protocols:**
If your overtake module communicates with an external USB device that expects an initialization handshake (like the M8's Launchpad Pro protocol), be proactive—don't wait for the device to initiate. The device may have already sent its request before your module loaded due to the ~500ms init delay. Instead:
- Send your identification/init message in `init()` immediately
- Optionally retry periodically in `tick()` until connection is confirmed
- Detect connection from any valid response (not just the specific handshake message)

## Module Store

The Module Store (`store` module) downloads and installs external modules from GitHub releases. The catalog is fetched from:
`https://raw.githubusercontent.com/charlesvestal/move-anything/main/module-catalog.json`

### Catalog Format (v2)

```json
{
  "catalog_version": 2,
  "host": {
    "name": "Move Anything",
    "github_repo": "charlesvestal/move-anything",
    "asset_name": "move-anything.tar.gz",
    "latest_version": "0.3.11",
    "download_url": "https://github.com/.../move-anything.tar.gz",
    "min_host_version": "0.1.0"
  },
  "modules": [
    {
      "id": "mymodule",
      "name": "My Module",
      "description": "What it does",
      "author": "Your Name",
      "component_type": "sound_generator",
      "github_repo": "username/move-anything-mymodule",
      "asset_name": "mymodule-module.tar.gz",
      "min_host_version": "0.1.0"
    }
  ]
}
```

### How the Store Works

1. Fetches `module-catalog.json` and extracts `catalog.modules` array
2. For each module, queries GitHub API for latest release
3. Looks for asset matching `<module-id>-module.tar.gz`
4. Compares release version to installed version
5. Downloads and extracts tarball to category subdirectory (e.g., `modules/sound_generators/<id>/`)

### Adding a Module to the Catalog

Edit `module-catalog.json` and add an entry to the `modules` array (see format above).

## External Module Development

External modules live in separate repos (e.g., `move-anything-sf2`, `move-anything-obxd`).

### Module Repo Structure

```
move-anything-<id>/
  src/
    module.json       # Module metadata (id, name, version, capabilities)
    ui.js             # JavaScript UI
    dsp/              # Native DSP code (if applicable)
      plugin.c/cpp
  scripts/
    build.sh          # Build script (creates dist/ and tarball)
    install.sh        # Deploy to Move device
    Dockerfile        # Cross-compilation environment
  .github/
    workflows/
      release.yml     # Automated release on tag push
```

### Build Script Requirements

`scripts/build.sh` must:
1. Cross-compile DSP code for ARM64 (via Docker)
2. Package files to `dist/<module-id>/`
3. Create tarball at `dist/<module-id>-module.tar.gz`

Example tarball creation (at end of build.sh):
```bash
# Create tarball for release
cd dist
tar -czvf mymodule-module.tar.gz mymodule/
cd ..
```

### Release Workflow

`.github/workflows/release.yml` triggers on version tags:
```yaml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - run: |
          docker build -t module-builder -f scripts/Dockerfile .
          docker run --rm -v "$PWD:/build" -w /build module-builder ./scripts/build.sh
      - uses: softprops/action-gh-release@v1
        with:
          files: dist/<module-id>-module.tar.gz
```

### Releasing a New Version

1. Update version in `src/module.json`
2. Commit: `git commit -am "bump version to 0.2.0"`
3. Tag and push: `git tag v0.2.0 && git push --tags`
4. GitHub Actions builds and uploads tarball to release

The Module Store will see the new version within minutes.

See `BUILDING.md` for detailed documentation.

## Dependencies

- QuickJS: libs/quickjs/
- stb_image.h: src/lib/
- curl: libs/curl/ (for Module Store downloads)
