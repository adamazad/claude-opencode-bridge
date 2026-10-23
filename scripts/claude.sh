#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BRIDGE_OWNER=${BRIDGE_OWNER:-$(uuidgen)}
export BRIDGE_OWNER
printf 'Bridge owner: %s (save this ID to resume the same conversation)\n' "$BRIDGE_OWNER" >&2
exec claude --plugin-dir "$root" --dangerously-load-development-channels plugin:opencode-bridge@inline "$@"
