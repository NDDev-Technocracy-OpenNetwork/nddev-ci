"""Parse untrusted YAML using the safe native loader."""

import yaml


def read(payload: str):
    return yaml.safe_load(payload)
