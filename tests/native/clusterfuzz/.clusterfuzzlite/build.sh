#!/bin/bash
set -euo pipefail
# These native SDK flag lists intentionally undergo shell word splitting.
# shellcheck disable=SC2086
$CXX $CXXFLAGS -std=c++17 parser.cc -o "$OUT/native_parser" $LIB_FUZZING_ENGINE
