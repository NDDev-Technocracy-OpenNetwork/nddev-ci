#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
checksum() {
  local total=0 value
  local -a values
  while read -r -a values; do
    for value in "${values[@]}"; do
      total=$(((total + value) % 256))
    done
  done < <(printf '%s' "$1" | od -An -tu1)
  printf '%s\n' "$total"
}
