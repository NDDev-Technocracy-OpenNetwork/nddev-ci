#!/usr/bin/env bats
# SPDX-License-Identifier: AGPL-3.0-only
setup() { source "$BATS_TEST_DIRNAME/checksum.sh"; }
@test "ASCII checksum is stable" {
  run checksum ci
  [ "$status" -eq 0 ]
  [ "$output" = 204 ]
}
@test "empty input remains zero" {
  run checksum ""
  [ "$status" -eq 0 ]
  [ "$output" = 0 ]
}
@test "UTF8 is handled as bytes" {
  run checksum ü
  [ "$status" -eq 0 ]
  [ "$output" = 127 ]
}
