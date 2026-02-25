/*
 * Slicer — move-anything DSP module
 * Transient-detection sample slicer, 128 slices, trigger/gate, A/D envelope
 * API v2, 44100Hz, stereo interleaved int16_t, 128 frames/block
 */

#include "host/plugin_api_v1.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <stdint.h>

#define SAMPLE_RATE     44100
#define BLOCK_SIZE      128
#define MAX_SLICES      128
#define MAX_VOICES      8

/* ── Envelope states ─────────────────────────────────────────────────────── */
typedef enum { ENV_IDLE, ENV_ATTACK, ENV_SUSTAIN, ENV_DECAY } env_state_t;

/* ── Voice ───────────────────────────────────────────────────────────────── */
typedef struct {
    int       active;
    int       note;
    int       slice_idx;
    int32_t   pos;           /* current read position in samples (fixed point: pos >> 16) */
    float     rate;          /* playback rate (pitch shift) */
    int32_t   slice_start;   /* sample index */
    int32_t   slice_end;     /* sample index */
    env_state_t env_state;
    float     env_val;
    float     env_attack;    /* coeff per sample */
    float     env_decay;     /* coeff per sample */
    float     velocity;
} voice_t;

/* ── Main plugin state ───────────────────────────────────────────────────── */
typedef struct {
    /* sample data */
    int16_t  *sample_data;   /* stereo interleaved */
    int32_t   sample_frames; /* total frames */
    char      sample_path[512];

    /* slices */
    int32_t   slice_points[MAX_SLICES + 1]; /* slice_points[i] = start of slice i */
    int       slice_count_actual;           /* how many slices detected */

    /* params */
    float     sensitivity;   /* 0.0–1.0 */
    int       slice_count;   /* 8/16/32/64/128 */
    float     pitch;         /* semitones ±24 */
    float     gain;
    int       mode_gate;     /* 0=trigger, 1=gate */
    float     attack_ms;
    float     decay_ms;
    float     start_trim;    /* 0.0–1.0 */
    float     end_trim;      /* 0.0–1.0 */

    /* voices */
    voice_t   voices[MAX_VOICES];
} slicer_t;

/* ── Helpers ─────────────────────────────────────────────────────────────── */
static float semitones_to_rate(float semitones) {
    return powf(2.0f, semitones / 12.0f);
}

static float ms_to_coeff(float ms, float target) {
    /* one-pole filter coeff for attack/decay */
    if (ms < 0.5f) return 1.0f; /* instant */
    int samples = (int)(ms * SAMPLE_RATE / 1000.0f);
    return powf(target, 1.0f / (float)samples);
}

/* ── WAV loader (16-bit and 24-bit PCM, any chunk layout) ────────────────── */
static int load_wav(slicer_t *s, const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;

    char tag[4];
    uint32_t u32;

    /* RIFF / WAVE header */
    if (fread(tag, 1, 4, f) < 4 || memcmp(tag, "RIFF", 4) != 0) { fclose(f); return 0; }
    fread(&u32, 4, 1, f); /* RIFF size, ignored */
    if (fread(tag, 1, 4, f) < 4 || memcmp(tag, "WAVE", 4) != 0) { fclose(f); return 0; }

    uint16_t channels = 0, bits_per_sample = 0, audio_format = 0;
    uint32_t data_size = 0;
    long     data_offset = 0;
    int      found_fmt = 0, found_data = 0;

    /* scan chunks to find "fmt " and "data" */
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
            /* skip unknown chunk, pad to even byte boundary */
            fseek(f, (long)(chunk_size + (chunk_size & 1)), SEEK_CUR);
        }
    }

    if (!found_fmt || !found_data || channels == 0 || data_size == 0) { fclose(f); return 0; }
    /* PCM (1) or extensible (0xFFFE); not float */
    if (audio_format != 1 && audio_format != 0xFFFE) { fclose(f); return 0; }
    /* 16-bit or 24-bit only */
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
            /* mono → stereo */
            int16_t *mono = malloc((size_t)frames * sizeof(int16_t));
            if (!mono) { free(buf); fclose(f); return 0; }
            fread(mono, sizeof(int16_t), (size_t)frames, f);
            for (int32_t i = 0; i < frames; i++) {
                buf[i*2] = buf[i*2+1] = mono[i];
            }
            free(mono);
        }
    } else {
        /* 24-bit: read raw, convert to 16-bit */
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
/*
 * Simple energy-based onset detection:
 * Compare RMS of current window vs previous window.
 * If ratio exceeds threshold, mark as transient.
 * Falls back to equal-division if < 2 transients found.
 */
static void detect_slices(slicer_t *s) {
    if (!s->sample_data || s->sample_frames == 0) return;

    int32_t total_start = (int32_t)(s->start_trim * s->sample_frames);
    int32_t total_end   = (int32_t)(s->end_trim   * s->sample_frames);
    int32_t region      = total_end - total_start;
    if (region <= 0) return;

    int win = 512; /* analysis window in frames */
    float threshold = 1.5f + (1.0f - s->sensitivity) * 8.0f;
    /* sensitivity=1.0 → threshold=1.5 (very sensitive) */
    /* sensitivity=0.0 → threshold=9.5 (only loud hits) */

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

        if (rms > prev_rms * threshold && rms > 0.01f) {
            /* avoid double-triggers: enforce min gap */
            int32_t min_gap = SAMPLE_RATE / 32; /* ~3ms */
            if (nmarkers == 0 || (i - markers[nmarkers-1]) > min_gap) {
                markers[nmarkers++] = i;
            }
        }
        prev_rms = rms * 0.3f + prev_rms * 0.7f; /* smoothed */
    }

    /* fallback: not enough transients → equal division */
    if (nmarkers < 2) {
        nmarkers = 0;
        int32_t step = region / s->slice_count;
        for (int i = 0; i < s->slice_count; i++) {
            markers[nmarkers++] = total_start + i * step;
        }
    }

    /* copy to slice_points, add sentinel at end */
    s->slice_count_actual = nmarkers;
    for (int i = 0; i < nmarkers; i++) {
        s->slice_points[i] = markers[i];
    }
    s->slice_points[nmarkers] = total_end; /* sentinel */
}

/* ── Voice management ────────────────────────────────────────────────────── */
static voice_t* find_free_voice(slicer_t *s) {
    for (int i = 0; i < MAX_VOICES; i++) {
        if (!s->voices[i].active) return &s->voices[i];
    }
    /* steal oldest (voice 0 — simple round-robin would be better but fine for v1) */
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
    int32_t start = s->slice_points[slice_idx];
    int32_t end   = s->slice_points[slice_idx + 1];
    if (end <= start) return;

    voice_t *v = find_free_voice(s);
    v->active      = 1;
    v->note        = note;
    v->slice_idx   = slice_idx;
    v->pos         = start << 16; /* fixed point */
    v->rate        = semitones_to_rate(s->pitch);
    v->slice_start = start;
    v->slice_end   = end;
    v->env_state   = ENV_ATTACK;
    v->env_val     = 0.0f;
    v->env_attack  = ms_to_coeff(s->attack_ms,  0.001f); /* attack → 1.0 */
    v->env_decay   = ms_to_coeff(s->decay_ms,   0.001f); /* decay  → 0.0 */
    v->velocity    = velocity / 127.0f;
}

static void voice_release(voice_t *v) {
    if (v->active && v->env_state != ENV_IDLE) {
        v->env_state = ENV_DECAY;
    }
}

/* ── API callbacks ───────────────────────────────────────────────────────── */
static void* v2_create_instance(const char *module_dir, const char *json_defaults) {
    (void)module_dir; (void)json_defaults;
    slicer_t *s = calloc(1, sizeof(slicer_t));
    s->sensitivity  = 0.5f;
    s->slice_count  = 16;
    s->pitch        = 0.0f;
    s->gain         = 0.8f;
    s->mode_gate    = 0;
    s->attack_ms    = 5.0f;
    s->decay_ms     = 200.0f;
    s->start_trim   = 0.0f;
    s->end_trim     = 1.0f;
    return s;
}

static void v2_destroy_instance(void *inst) {
    slicer_t *s = inst;
    if (s->sample_data) free(s->sample_data);
    free(s);
}

static void v2_set_param(void *inst, const char *key, const char *val) {
    slicer_t *s = inst;

    if (strcmp(key, "sensitivity") == 0) {
        s->sensitivity = atof(val);
        detect_slices(s);
    } else if (strcmp(key, "slices") == 0) {
        int n = atoi(val);
        if (n==8||n==16||n==32||n==64||n==128) s->slice_count = n;
        detect_slices(s);
    } else if (strcmp(key, "pitch") == 0) {
        s->pitch = atof(val);
    } else if (strcmp(key, "gain") == 0) {
        s->gain = atof(val);
    } else if (strcmp(key, "mode") == 0) {
        s->mode_gate = (strcmp(val, "gate") == 0) ? 1 : 0;
    } else if (strcmp(key, "attack") == 0) {
        s->attack_ms = atof(val);
    } else if (strcmp(key, "decay") == 0) {
        s->decay_ms = atof(val);
    } else if (strcmp(key, "start_trim") == 0) {
        s->start_trim = atof(val);
        detect_slices(s);
    } else if (strcmp(key, "end_trim") == 0) {
        s->end_trim = atof(val);
        detect_slices(s);
    } else if (strcmp(key, "sample_path") == 0) {
        if (load_wav(s, val)) detect_slices(s);
    }
}

static int v2_get_param(void *inst, const char *key, char *buf, int buf_len) {
    slicer_t *s = inst;
    if (strcmp(key, "sensitivity") == 0)  return snprintf(buf, buf_len, "%.3f", s->sensitivity);
    if (strcmp(key, "slices") == 0)        return snprintf(buf, buf_len, "%d",   s->slice_count);
    if (strcmp(key, "pitch") == 0)         return snprintf(buf, buf_len, "%.1f", s->pitch);
    if (strcmp(key, "gain") == 0)          return snprintf(buf, buf_len, "%.3f", s->gain);
    if (strcmp(key, "mode") == 0)          return snprintf(buf, buf_len, "%s",   s->mode_gate ? "gate" : "trigger");
    if (strcmp(key, "attack") == 0)        return snprintf(buf, buf_len, "%.1f", s->attack_ms);
    if (strcmp(key, "decay") == 0)         return snprintf(buf, buf_len, "%.1f", s->decay_ms);
    if (strcmp(key, "start_trim") == 0)    return snprintf(buf, buf_len, "%.4f", s->start_trim);
    if (strcmp(key, "end_trim") == 0)      return snprintf(buf, buf_len, "%.4f", s->end_trim);
    if (strcmp(key, "sample_path") == 0)   return snprintf(buf, buf_len, "%s",   s->sample_path);
    if (strcmp(key, "slice_count_actual") == 0) return snprintf(buf, buf_len, "%d", s->slice_count_actual);
    return -1;
}

static void v2_on_midi(void *inst, const uint8_t *msg, int len, int source) {
    (void)source; (void)len;
    slicer_t *s = inst;

    uint8_t status   = msg[0] & 0xF0;
    uint8_t note     = msg[1];
    uint8_t velocity = (len > 2) ? msg[2] : 0;

    if (status == 0x90 && velocity > 0) {
        /* note on */
        voice_start(s, note, velocity);
    } else if (status == 0x80 || (status == 0x90 && velocity == 0)) {
        /* note off */
        if (s->mode_gate) {
            voice_t *v = find_voice_for_note(s, note);
            if (v) voice_release(v);
        }
        /* in trigger mode, note-off is ignored — slice plays to end */
    }
}

static void v2_render_block(void *inst, int16_t *out_lr, int frames) {
    slicer_t *s = inst;
    memset(out_lr, 0, frames * 2 * sizeof(int16_t));
    if (!s->sample_data) return;

    for (int vi = 0; vi < MAX_VOICES; vi++) {
        voice_t *v = &s->voices[vi];
        if (!v->active) continue;

        for (int i = 0; i < frames; i++) {
            /* envelope */
            float env = v->env_val;
            switch (v->env_state) {
                case ENV_ATTACK:
                    env = env + (1.0f - env) * (1.0f - v->env_attack);
                    if (env >= 0.999f) {
                        env = 1.0f;
                        v->env_state = (!s->mode_gate) ? ENV_DECAY : ENV_SUSTAIN;
                    }
                    break;
                case ENV_SUSTAIN:
                    env = 1.0f;
                    break;
                case ENV_DECAY:
                    env *= v->env_decay;
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

            /* read position */
            int32_t pos_int = v->pos >> 16;
            if (pos_int >= v->slice_end) {
                /* reached end of slice */
                v->env_state = ENV_IDLE;
                v->active    = 0;
                break;
            }

            /* linear interpolation */
            float frac      = (v->pos & 0xFFFF) / 65536.0f;
            int32_t pos_next = pos_int + 1;
            if (pos_next >= v->slice_end) pos_next = v->slice_end - 1;

            float l = s->sample_data[pos_int*2]   * (1.0f - frac)
                    + s->sample_data[pos_next*2]   * frac;
            float r = s->sample_data[pos_int*2+1] * (1.0f - frac)
                    + s->sample_data[pos_next*2+1] * frac;

            float amp = v->velocity * s->gain * env;
            l *= amp;
            r *= amp;

            /* clamp and mix */
            int32_t ol = out_lr[i*2]   + (int32_t)l;
            int32_t or_ = out_lr[i*2+1] + (int32_t)r;
            out_lr[i*2]   = (int16_t)(ol >  32767 ?  32767 : ol < -32768 ? -32768 : ol);
            out_lr[i*2+1] = (int16_t)(or_ >  32767 ?  32767 : or_ < -32768 ? -32768 : or_);

            /* advance position */
            v->pos += (int32_t)(v->rate * 65536.0f);
        }
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
