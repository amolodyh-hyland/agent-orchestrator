#!/bin/bash
# One-command update: install.sh --update. Run from your own Terminal (or add --detached).
set -euo pipefail

script_dir="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
exec "$script_dir/install.sh" --update "$@"
