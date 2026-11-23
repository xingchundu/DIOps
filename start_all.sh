#!/bin/bash
# Alias entry: same as start-all.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT/start-all.sh" "$@"
