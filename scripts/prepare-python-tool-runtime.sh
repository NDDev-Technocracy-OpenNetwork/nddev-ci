#!/usr/bin/env bash
# Prepare with the original uv, then report that callee's actual environment.
# The native owner retains placement, transport and lease authority.
set -euo pipefail
if (( $# < 2 )); then
  echo 'Expected the original uv and tool project' >&2
  exit 2
fi
uv="$1"
project="$2"
shift 2
"$uv" sync --locked "$@" --project "$project" --python 3.13 >&2
runtime="$("$uv" run --locked --no-sync "$@" --project "$project" --python 3.13 \
  python -I -c 'import sys; print(sys.prefix)')"
if [[ "$runtime" != /* || "$runtime" == *$'\n'* || "$runtime" == *$'\r'* || ! -x "$runtime/bin/python" ]]; then
  echo 'The prepared uv callee supplied no usable absolute runtime' >&2
  exit 2
fi
printf '%s\n' "$runtime"
