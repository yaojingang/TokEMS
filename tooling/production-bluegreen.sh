#!/usr/bin/env bash
# Independent entry point. Never source or modify production-deploy.sh.
set -Eeuo pipefail
umask 077
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/bluegreen/controller.py" "$@"
