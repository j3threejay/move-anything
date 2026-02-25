#!/usr/bin/env bash
# Build and deploy just the slicer module to the Move over SSH.
# Mirrors the cross-compilation pattern from build.sh (Docker or local CROSS_PREFIX).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
IMAGE_NAME="move-anything-builder"

MOVE_HOST="${MOVE_HOST:-move.local}"
SSH_OPTS="-o LogLevel=QUIET -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -n"
SRC_DIR="$REPO_ROOT/src/modules/sound_generators/slicer"
OUT_DIR="$REPO_ROOT/build/modules/sound_generators/slicer"
DEST="/data/UserData/move-anything/modules/sound_generators/slicer"

# ── 1. Build dsp.so ───────────────────────────────────────────────────────────

mkdir -p "$OUT_DIR"

if [ -z "$CROSS_PREFIX" ] && [ ! -f "/.dockerenv" ]; then
    echo "=== Building slicer (via Docker) ==="
    if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
        echo "Building Docker image (first time only)..."
        docker build -t "$IMAGE_NAME" "$REPO_ROOT"
    fi
    docker run --rm \
        --entrypoint /bin/sh \
        -v "$REPO_ROOT:/build" \
        -u "$(id -u):$(id -g)" \
        "$IMAGE_NAME" \
        -c "mkdir -p /build/build/modules/sound_generators/slicer && \
            aarch64-linux-gnu-gcc -g -O3 -shared -fPIC \
                /build/src/modules/sound_generators/slicer/dsp.c \
                -o /build/build/modules/sound_generators/slicer/dsp.so \
                -I/build/src -lm"
else
    echo "=== Building slicer (local cross-compiler: ${CROSS_PREFIX}gcc) ==="
    "${CROSS_PREFIX}gcc" -g -O3 -shared -fPIC \
        "$SRC_DIR/dsp.c" \
        -o "$OUT_DIR/dsp.so" \
        -I"$REPO_ROOT/src" -lm
fi

echo "Built: $OUT_DIR/dsp.so ($(file "$OUT_DIR/dsp.so" | grep -o 'ARM aarch64[^,]*' || echo 'unknown arch'))"

# ── 2. Deploy to Move ─────────────────────────────────────────────────────────

echo ""
echo "=== Deploying to $MOVE_HOST ==="

ssh $SSH_OPTS "ableton@$MOVE_HOST" "mkdir -p $DEST"

scp -o LogLevel=QUIET -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
    "$OUT_DIR/dsp.so" \
    "$SRC_DIR/module.json" \
    "$SRC_DIR/ui_chain.js" \
    "ableton@$MOVE_HOST:$DEST/"

echo "Copied: dsp.so  module.json  ui_chain.js → $DEST/"

# ── 3. Restart Move service ───────────────────────────────────────────────────

echo "Restarting Move service..."
ssh $SSH_OPTS "root@$MOVE_HOST" \
    "/etc/init.d/move stop >/dev/null 2>&1 || true; sleep 1; /etc/init.d/move start >/dev/null 2>&1"

echo ""
echo "Done. Slicer deployed to $MOVE_HOST."
