# Native Flutter fixture

The Flutter SDK selected by the native workflow and its bundled Dart SDK run locked dependency installation, fatal-info analysis,
widget tests, native localization generation with drift checking, and a release web build.
`tests/run_native.py flutter` also verifies that invalid Dart source fails the selected checks.
The generic imported fixture retains the notice in `../NOTICE`; web platform scaffolding and
localization sources were generated/adapted with this exact Flutter SDK.
