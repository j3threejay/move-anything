/*
 * Slicer — move-anything DSP module
 * Transient-detection sample slicer, 128 slices, trigger/gate, A/D envelope
 * API v2, 44100Hz, stereo interleaved int16_t, 128 frames/block
 *
 * Per-pad params: start_offset_ms, end_offset_ms, attack_ms, decay_ms, gain, loop_mode
 * Global params:  pitch, mode_gate, threshold, slice_count
 */

#include "host/plugin_api_v1.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <stdint.h>

#define SAMPLE_RATE      44100
#define BLOCK_SIZE       128
#define MAX_SLICES       128
#define MAX_VOICES       8
#define RELEASE_SAMPLES  64   /* ~1.5ms fade-out when slice end is reached */

/* loop modes */
#define LOOP_OFF      0
#define LOOP_FORWARD  1
#define LOOP_PINGPONG 2

/* ── Envelope states ─────────────────────────────────────────────────────── */
typedef enum { ENV_IDLE, ENV_ATTACK, ENV_SUSTAIN, ENV_DECAY } env_state_t;

/* ── Voice ───────────────────────────────────────────────────────────────── */
typedef struct {
    int       active;
    int       note;
    int       slice_idx;
    int64_t   pos;           /* current read position (fixed point: pos >> 16) */
    float     rate;          /* playback rate (pitch shift) */
    int       direction;     /* +1 forward, -1 reverse (ping pong) */
    int32_t   slice_start;   /* effective start after trim offset */
    int32_t   slice_end;     /* effective end after trim offset */
    int       loop_mode;     /* per-voice snapshot of pad's loop_mode */
    env_state_t env_state;
    float     env_val;
    float     env_attack;    /* coeff per sample */
    float     env_decay;     /* coeff per sample */
    float     velocity;
    float     pad_gain;      /* per-pad gain snapshot */
    int       release;       /* countdown for end-of-slice fade-out */
    int       released;      /* note has been released (gate mode) */
} voice_t;

/* ── Per-pad parameters ──────────────────────────────────────────────────── */
typedef struct {
    float  start_offset_ms;  /* offset from detected slice start, ± ms */
    float  end_offset_ms;    /* offset from detected slice end, ± ms */
    float  attack_ms;
    float  decay_ms;
    float  gain;             /* 0.0–1.0 */
    int    loop_mode;        /* LOOP_OFF / LOOP_FORWARD / LOOP_PINGPONG */
} pad_params_t;

/* ── Main plugin state ───────────────────────────────────────────────────── */
typedef struct {
    /* sample data */
    int16_t  *sample_data;   /* stereo interleaved */
    int32_t   sample_frames; /* total frames */
    char      sample_path[512];

    /* slices */
    int32_t   slice_points[MAX_SLICES + 1];
    int       slice_count_actual;

    /* global params */
    float     threshold;
    int       slice_count;   /* 8/16/32/64/128 */
    float     pitch;         /* semitones ±24 */
    int       mode_gate;     /* 0=trigger, 1=gate */

    /* per-pad params */
    pad_params_t pads[MAX_SLICES];

    /* selected slice (for param get/set from UI) */
    int       selected_slice;

    /* state */
    int       slicer_state;  /* 0=IDLE, 1=READY, 2=NO_SLICES */

    /* voices */
    voice_t   voices[MAX_VOICES];
} slicer_t;

/* ── Helpers ─────────────────────────────────────────────────────────────── */
static float semitones_to_rate(float semitones) {
    return powf(2.0f, semitones / 12.0f);
}

static inline int16_t clamp16(float v) {
    if (v >  32767.0f) return  32767;
    if (v < -32768.0f) return -32768;
    return (int16_t)v;
}

static inline int32_t clampi(int32_t v, int32_t lo, int32_t hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

static float ms_to_coeff(float ms, float target) {
    if (ms < 0.5f) return 1.0f;
    int samples = (int)(ms * SAMPLE_RATE / 1000.0f);
    return powf(target, 1.0f / (float)samples);
}

static inline float ms_to_frames(float ms) {
    return ms * SAMPLE_RATE / 1000.0f;
}

static void reset_pad(pad_params_t *p) {
    p->start_offset_ms = 0.0f;
    p->end_offset_ms   = 0.0f;
    p->attack_ms       = 5.0f;
    p->decay_ms        = 500.0f;
    p->gain            = 0.8f;
    p->loop_mode       = LOOP_OFF;
}

/* ── WAV loader (16-bit and 24-bit PCM, any chunk layout) ────────────────── */
static int load_wav(slicer_t *s, const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;

    char tag[4];
    uint32_t u32;

    if (fread(tag, 1, 4, f) < 4 || memcmp(tag, "RIFF", 4) != 0) { fclose(f); return 0; }
    fread(&u32, 4, 1, f);
    if (fread(tag, 1, 4, f) < 4 || memcmp(tag, "WAVE", 4) != 0) { fclose(f); return 0; }

    uint16_t channels = 0, bits_per_sample = 0, audio_format = 0;
    uint32_t data_size = 0;
    long     data_offset = 0;
    int      found_fmt = 0, found_data = 0;

    char     chunk_id[4];
    uint32_t chunk_size;
    while (fread(chunk_id, 1, 4, f) == 4 && fread(&chunk_size, 4, 1, f) == 1) {
        if (memcmp(chunk_id, "fmt ", 4) == 0) {
            uint8_t fmt[16];
            uint32_t rd = chunk_size < 16 ? chunk_size : 16;
            if (fread(fmt, 1, rd, f) < rd) { fclose(f); return 0; }
            if (chunk_size > rd) fseek(f, (long)(chunk_size - rd), SEEK_CUR);
            audio_format    = fmt[0]  | (fmt[1] <<8);
            channels        = fmt[2]  | (fmt[3] <<8);
            bits_per_sample = fmt[14] | (fmt[15]<<8);
            found_fmt = 1;
        } else if (memcmp(chunk_id, "data", 4) == 0) {
            data_size   = chunk_size;
            data_offset = ftell(f);
            found_data  = 1;
            break;
        } else {
            fseek(f, (long)(chunk_size + (chunk_size & 1)), SEEK_CUR);
        }
    }

    if (!found_fmt || !found_data || channels == 0 || data_size == 0) { fclose(f); return 0; }
    if (audio_format != 1 && audio_format != 0xFFFE) { fclose(f); return 0; }
    if (bits_per_sample != 16 && bits_per_sample != 24) { fclose(f); return 0; }

    uint32_t bytes_per_smp = bits_per_sample / 8;
    int32_t  frames = (int32_t)(data_size / (channels * bytes_per_smp));
    if (frames <= 0) { fclose(f); return 0; }

    int16_t *buf = malloc((size_t)frames * 2 * sizeof(int16_t));
    if (!buf) { fclose(f); return 0; }

    fseek(f, data_offset, SEEK_SET);

    if (bits_per_sample == 16) {
        if (channels == 2) {
            fread(buf, sizeof(int16_t), (size_t)frames * 2, f);
        } else {
            int16_t *mono = malloc((size_t)frames * sizeof(int16_t));
            if (!mono) { free(buf); fclose(f); return 0; }
            fread(mono, sizeof(int16_t), (size_t)frames, f);
            for (int32_t i = 0; i < frames; i++) buf[i*2] = buf[i*2+1] = mono[i];
            free(mono);
        }
    } else {
        uint32_t raw_size = (uint32_t)frames * channels * 3;
        uint8_t *raw = malloc(raw_size);
        if (!raw) { free(buf); fclose(f); return 0; }
        fread(raw, 1, raw_size, f);
        for (int32_t i = 0; i < frames; i++) {
            for (int c = 0; c < 2; c++) {
                int src_c = (c < (int)channels) ? c : 0;
                int off   = (int)(i * channels * 3 + src_c * 3);
                int32_t v = ((int32_t)raw[off+2] << 24)
                          | ((int32_t)raw[off+1] << 16)
                          | ((int32_t)raw[off+0] << 8);
                buf[i*2+c] = (int16_t)(v >> 16);
            }
        }
        free(raw);
    }

    fclose(f);

    if (s->sample_data) free(s->sample_data);
    s->sample_data   = buf;
    s->sample_frames = frames;
    strncpy(s->sample_path, path, sizeof(s->sample_path)-1);
    return 1;
}

/* ── Transient detection ─────────────────────────────────────────────────── */
static void detect_slices(slicer_t *s) {
    if (!s->sample_data || s->sample_frames == 0) return;

    int32_t total_start = 0;
    int32_t total_end   = s->sample_frames;
    int32_t region      = total_end - total_start;
    if (region <= 0) return;

    int win = 512;
    float det_threshold = 1.5f + (1.0f - s->threshold) * 8.0f;

    int32_t markers[MAX_SLICES];
    int     nmarkers = 0;
    markers[nmarkers++] = total_start;

    float prev_rms = 0.001f;

    for (int32_t i = total_start; i < total_end - win && nmarkers < s->slice_count; i += win/2) {
        float rms = 0.0f;
        for (int j = 0; j < win; j++) {
            int32_t idx = (i + j) * 2;
            float l = s->sample_data[idx]   / 32768.0f;
            float r = s->sample_data[idx+1] / 32768.0f;
            rms += l*l + r*r;
        }
        rms = sqrtf(rms / (win * 2));

        if (rms > prev_rms * det_threshold && rms > 0.01f) {
            int32_t min_gap = SAMPLE_RATE / 32;
            if (nmarkers == 0 || (i - markers[nmarkers-1]) > min_gap) {
                markers[nmarkers++] = i;
            }
        }
        prev_rms = rms * 0.3f + prev_rms * 0.7f;
    }

    if (nmarkers < 2) {
        nmarkers = 0;
        int32_t step = region / s->slice_count;
        for (int i = 0; i < s->slice_count; i++) {
            markers[nmarkers++] = total_start + i * step;
        }
    }

    s->slice_count_actual = nmarkers;
    for (int i = 0; i < nmarkers; i++) s->slice_points[i] = markers[i];
    s->slice_points[nmarkers] = total_end;

    /* reset all per-pad params on fresh scan */
    for (int i = 0; i < MAX_SLICES; i++) reset_pad(&s->pads[i]);
}

/* ── Voice management ────────────────────────────────────────────────────── */
static voice_t* find_free_voice(slicer_t *s) {
    for (int i = 0; i < MAX_VOICES; i++) {
        if (!s->voices[i].active) return &s->voices[i];
    }
    memset(&s->voices[0], 0, sizeof(voice_t));
    return &s->voices[0];
}

static voice_t* find_voice_for_note(slicer_t *s, int note) {
    for (int i = 0; i < MAX_VOICES; i++) {
        if (s->voices[i].active && s->voices[i].note == note) return &s->voices[i];
    }
    return NULL;
}

static void voice_start(slicer_t *s, int note, int velocity) {
    if (s->slice_count_actual == 0 || !s->sample_data) return;

    int slice_idx = note % s->slice_count_actual;
    pad_params_t *p = &s->pads[slice_idx];

    /* apply per-pad offsets to detected boundaries, clamp to file */
    int32_t base_start = s->slice_points[slice_idx];
    int32_t base_end   = s->slice_points[slice_idx + 1];
    int32_t start = clampi(base_start + (int32_t)ms_to_frames(p->start_offset_ms), 0, s->sample_frames - 1);
    int32_t end   = clampi(base_end   + (int32_t)ms_to_frames(p->end_offset_ms),   1, s->sample_frames);
    if (end <= start) end = start + 1;

    voice_t *v = find_voice_for_note(s, note);
    if (v) {
        memset(v, 0, sizeof(voice_t));
    } else {
        v = find_free_voice(s);
    }

    v->active      = 1;
    v->note        = note;
    v->slice_idx   = slice_idx;
    v->pos         = (int64_t)start << 16;
    v->rate        = semitones_to_rate(s->pitch);
    v->direction   = 1;
    v->slice_start = start;
    v->slice_end   = end;
    v->loop_mode   = p->loop_mode;
    v->env_state   = ENV_ATTACK;
    v->env_val     = 0.0f;
    /* NOTE: attack/decay coefficients are intentionally swapped here —
       the render loop uses env_decay for the attack ramp and env_attack
       for the decay ramp. This matches the hardware behavior after the
       coefficient-swap bug fix. */
    v->env_attack  = ms_to_coeff(p->decay_ms,  0.001f);
    v->env_decay   = ms_to_coeff(p->attack_ms, 0.001f);
    v->velocity    = velocity / 127.0f;
    v->pad_gain    = p->gain;
    v->release     = 0;
    v->released    = 0;
}

static void voice_release(voice_t *v) {
    if (v->active && v->env_state != ENV_IDLE) {
        v->released  = 1;
        v->env_state = ENV_DECAY;
    }
}

/* ── API callbacks ───────────────────────────────────────────────────────── */
static void* v2_create_instance(const char *module_dir, const char *json_defaults) {
    (void)module_dir; (void)json_defaults;
    slicer_t *s = calloc(1, sizeof(slicer_t));
    s->threshold      = 0.5f;
    s->slice_count    = 16;
    s->pitch          = 0.0f;
    s->mode_gate      = 0;
    s->selected_slice = 0;
    s->slicer_state   = 0;
    for (int i = 0; i < MAX_SLICES; i++) reset_pad(&s->pads[i]);
    return s;
}

static void v2_destroy_instance(void *inst) {
    slicer_t *s = inst;
    if (s->sample_data) free(s->sample_data);
    free(s);
}

static void v2_set_param(void *inst, const char *key, const char *val) {
    slicer_t *s = inst;

    /* global params */
    if (strcmp(key, "threshold") == 0) {
        s->threshold    = atof(val);
        s->slicer_state = 0;
    } else if (strcmp(key, "slices") == 0) {
        int n = atoi(val);
        if (n==8||n==16||n==32||n==64||n==128) s->slice_count = n;
        s->slicer_state = 0;
    } else if (strcmp(key, "pitch") == 0) {
        s->pitch = atof(val);
    } else if (strcmp(key, "mode") == 0) {
        s->mode_gate = (strcmp(val, "gate") == 0) ? 1 : 0;
    } else if (strcmp(key, "selected_slice") == 0) {
        int n = atoi(val);
        if (n >= 0 && n < MAX_SLICES) s->selected_slice = n;

    /* per-pad params (operate on selected_slice) */
    } else if (strcmp(key, "slice_start_trim") == 0) {
        s->pads[s->selected_slice].start_offset_ms = atof(val);
    } else if (strcmp(key, "slice_end_trim") == 0) {
        s->pads[s->selected_slice].end_offset_ms = atof(val);
    } else if (strcmp(key, "slice_attack") == 0) {
        s->pads[s->selected_slice].attack_ms = atof(val);
    } else if (strcmp(key, "slice_decay") == 0) {
        s->pads[s->selected_slice].decay_ms = atof(val);
    } else if (strcmp(key, "slice_gain") == 0) {
        s->pads[s->selected_slice].gain = atof(val);
    } else if (strcmp(key, "slice_loop") == 0) {
        int n = atoi(val);
        if (n >= LOOP_OFF && n <= LOOP_PINGPONG)
            s->pads[s->selected_slice].loop_mode = n;

    /* sample + scan */
    } else if (strcmp(key, "sample_path") == 0) {
        if (load_wav(s, val)) s->slicer_state = 0;
    } else if (strcmp(key, "scan") == 0) {
        detect_slices(s);
        s->slicer_state = (s->slice_count_actual > 0) ? 1 : 2;
    }
}

static int v2_get_param(void *inst, const char *key, char *buf, int buf_len) {
    slicer_t *s = inst;
    pad_params_t *p = &s->pads[s->selected_slice];

    /* global */
    if (strcmp(key, "threshold") == 0)         return snprintf(buf, buf_len, "%.3f", s->threshold);
    if (strcmp(key, "slices") == 0)             return snprintf(buf, buf_len, "%d",   s->slice_count);
    if (strcmp(key, "pitch") == 0)              return snprintf(buf, buf_len, "%.1f", s->pitch);
    if (strcmp(key, "mode") == 0)               return snprintf(buf, buf_len, "%s",   s->mode_gate ? "gate" : "trigger");
    if (strcmp(key, "sample_path") == 0)        return snprintf(buf, buf_len, "%s",   s->sample_path);
    if (strcmp(key, "slice_count_actual") == 0) return snprintf(buf, buf_len, "%d",   s->slice_count_actual);
    if (strcmp(key, "slicer_state") == 0)       return snprintf(buf, buf_len, "%d",   s->slicer_state);
    if (strcmp(key, "selected_slice") == 0)     return snprintf(buf, buf_len, "%d",   s->selected_slice);

    /* per-pad (for selected_slice) */
    if (strcmp(key, "slice_start_trim") == 0)   return snprintf(buf, buf_len, "%.1f", p->start_offset_ms);
    if (strcmp(key, "slice_end_trim") == 0)     return snprintf(buf, buf_len, "%.1f", p->end_offset_ms);
    if (strcmp(key, "slice_attack") == 0)       return snprintf(buf, buf_len, "%.1f", p->attack_ms);
    if (strcmp(key, "slice_decay") == 0)        return snprintf(buf, buf_len, "%.1f", p->decay_ms);
    if (strcmp(key, "slice_gain") == 0)         return snprintf(buf, buf_len, "%.3f", p->gain);
    if (strcmp(key, "slice_loop") == 0)         return snprintf(buf, buf_len, "%d",   p->loop_mode);

    return -1;
}

static void v2_on_midi(void *inst, const uint8_t *msg, int len, int source) {
    (void)source; (void)len;
    slicer_t *s = inst;

    uint8_t status   = msg[0] & 0xF0;
    uint8_t note     = msg[1];
    uint8_t velocity = (len > 2) ? msg[2] : 0;

    if (status == 0x90 && velocity > 0) {
        voice_start(s, note, velocity);
    } else if (status == 0x80 || (status == 0x90 && velocity == 0)) {
        /* always release on note-off — loop voices need this to stop */
        voice_t *v = find_voice_for_note(s, note);
        if (v) voice_release(v);
        /* non-gate trigger voices ignore release (play to end naturally) */
    }
}

static void v2_render_block(void *inst, int16_t *out_lr, int frames) {
    slicer_t *s = inst;
    if (!s->sample_data) { memset(out_lr, 0, frames * 2 * sizeof(int16_t)); return; }

    float mix_l[BLOCK_SIZE];
    float mix_r[BLOCK_SIZE];
    memset(mix_l, 0, frames * sizeof(float));
    memset(mix_r, 0, frames * sizeof(float));

    for (int vi = 0; vi < MAX_VOICES; vi++) {
        voice_t *v = &s->voices[vi];
        if (!v->active) continue;

        for (int i = 0; i < frames; i++) {
            /* envelope */
            if (v->env_state == ENV_IDLE) { v->active = 0; v->env_val = 0.0f; break; }
            float env = v->env_val;
            switch (v->env_state) {
                case ENV_ATTACK:
                    env = env + (1.0f - env) * (1.0f - v->env_decay);
                    if (env >= 0.999f) {
                        env = 1.0f;
                        /* looping voices sustain; trigger non-loop decays; gate sustains */
                        if (v->loop_mode != LOOP_OFF || s->mode_gate)
                            v->env_state = ENV_SUSTAIN;
                        else
                            v->env_state = ENV_DECAY;
                    }
                    break;
                case ENV_SUSTAIN:
                    env = 1.0f;
                    break;
                case ENV_DECAY:
                    env *= v->env_attack;
                    if (env < 0.0001f) {
                        env = 0.0f;
                        v->env_state = ENV_IDLE;
                        v->active = 0;
                    }
                    break;
                case ENV_IDLE:
                    v->active = 0;
                    break;
            }
            v->env_val = env;
            if (!v->active) break;

            /* position */
            int32_t pos_int = (int32_t)(v->pos >> 16);

            /* loop / ping-pong boundary handling */
            if (v->loop_mode == LOOP_FORWARD && !v->released) {
                if (pos_int >= v->slice_end) {
                    /* wrap back to start */
                    v->pos = (int64_t)v->slice_start << 16;
                    pos_int = v->slice_start;
                }
                if (pos_int < v->slice_start) {
                    v->pos = (int64_t)v->slice_start << 16;
                    pos_int = v->slice_start;
                }
            } else if (v->loop_mode == LOOP_PINGPONG && !v->released) {
                if (pos_int >= v->slice_end) {
                    v->direction = -1;
                    v->pos = ((int64_t)(v->slice_end - 1) << 16);
                    pos_int = v->slice_end - 1;
                } else if (pos_int < v->slice_start) {
                    v->direction = 1;
                    v->pos = (int64_t)v->slice_start << 16;
                    pos_int = v->slice_start;
                }
            } else {
                /* non-looping or released: normal end-of-slice fade */
                if (pos_int >= v->slice_end) {
                    if (v->release == 0) v->release = RELEASE_SAMPLES;
                    pos_int = v->slice_end - 1;
                }
            }

            /* linear interpolation */
            float frac       = (uint32_t)(v->pos & 0xFFFF) / 65536.0f;
            int32_t pos_next = pos_int + v->direction;
            if (pos_next >= v->slice_end)   pos_next = pos_int;
            if (pos_next < v->slice_start)  pos_next = pos_int;

            float l = s->sample_data[pos_int*2]   * (1.0f - frac)
                    + s->sample_data[pos_next*2]   * frac;
            float r = s->sample_data[pos_int*2+1] * (1.0f - frac)
                    + s->sample_data[pos_next*2+1] * frac;

            float amp = v->velocity * v->pad_gain * env;
            if (v->release > 0) {
                amp *= (float)v->release / (float)RELEASE_SAMPLES;
                if (--v->release == 0) { v->active = 0; v->env_val = 0.0f; }
            }

            mix_l[i] += l * amp;
            mix_r[i] += r * amp;
            if (!v->active) break;

            /* advance position (direction-aware) */
            v->pos += (int64_t)(v->direction * v->rate * 65536.0f);
        }
    }

    for (int i = 0; i < frames; i++) {
        out_lr[i*2]   = clamp16(mix_l[i]);
        out_lr[i*2+1] = clamp16(mix_r[i]);
    }
}

/* ── Plugin entry point ──────────────────────────────────────────────────── */
static plugin_api_v2_t g_api = {
    .api_version     = MOVE_PLUGIN_API_VERSION_2,
    .create_instance = v2_create_instance,
    .destroy_instance= v2_destroy_instance,
    .on_midi         = v2_on_midi,
    .set_param       = v2_set_param,
    .get_param       = v2_get_param,
    .render_block    = v2_render_block
};

plugin_api_v2_t* move_plugin_init_v2(const host_api_v1_t *host) {
    (void)host;
    return &g_api;
}
