#!/bin/bash
# Convenience wrapper: stop all services started by start-all.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT/start-all.sh" stop
