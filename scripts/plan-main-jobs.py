"""Map the existing affected-component closure to its actual native platform cells."""

import json
import os
import tomllib
from pathlib import Path


def plan(selected, components):
    selected = set(selected)
    fixtures = {name for name in components if name.startswith("fixture-")}
    runtime = "runtime" in selected
    if runtime:
        assert fixtures <= selected, "The shared runtime must retain every dependent native fixture"
    linux = sorted(name.removeprefix("fixture-") for name in fixtures & selected if name != "fixture-swift")
    return {
        "matrix": {"profile": linux or ["python"]},
        "native": bool(linux),
        "runtime": runtime,
        "windows": runtime or "fixture-python" in selected,
        "apple": runtime or "fixture-swift" in selected,
        "advanced": "advanced" in selected,
        "quality": "native-quality" in selected,
        "benchmark": "native-benchmark" in selected,
        "assessment": "native-assessment" in selected,
        "clusterfuzz": "native-clusterfuzz" in selected,
    }


if __name__ == "__main__":
    components = tomllib.loads(Path(".github/impact.toml").read_text())["impact"]["components"]
    values = plan(json.loads(os.environ["SELECTED"]), components)
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        for key, value in values.items():
            print(key + "=" + json.dumps(value), file=stream)
