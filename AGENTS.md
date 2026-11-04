# NDDev CI library

This repository supplies reusable GitHub Actions, workflows and the Python
implementation that they invoke. Keep public and external runner execution
isolated from managed cache and private fleet credentials.

Use the locked native commands in the justfile. Treat published action and
workflow SHAs as immutable. Update the implementation and facade pins before
changing a caller. Preserve old published entrypoints during migration.
