# Executable routing example

The same admission operation is runnable without GitHub or private authoring tools.

    >>> from nddev_cicd.routing import select
    >>> select("public", "linux")["provider"]
    'github'
    >>> select("private", "linux", trusted=True, private_labels=["self-hosted", "Linux", "X64", "fixture-linux"])["provider"]
    'self-hosted'

Run `uv run python examples/routing.py` for the actual native labels on each public OS.
