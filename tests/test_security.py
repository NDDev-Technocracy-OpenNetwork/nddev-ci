"""Native scanner scope and result validation cannot substitute empty work for feedback."""

import json

import pytest

from nddev_cicd import security
from nddev_cicd.model import Invalid


def test_semgrep_requires_local_tracked_rules_and_real_source(repository):
    root = repository({"source.js": "const result = 1;\n", "rules.yml": "rules: []\n"})
    settings = {"engine": "semgrep", "paths": ["source.js"], "rules": ["rules.yml"]}
    with pytest.raises(Invalid):
        security.native_command(
            "security-sast", root, {"security": {**settings, "rules": ["https://example.invalid/rules.yml"]}}
        )
    with pytest.raises(Invalid):
        security.native_command("security-sast", root, {"security": {**settings, "paths": ["missing/*.js"]}})
    (root / "untracked.yml").write_text("rules: []\n")
    with pytest.raises(Invalid, match="tracked"):
        security.native_command("security-sast", root, {"security": {**settings, "rules": ["untracked.yml"]}})


@pytest.mark.parametrize(
    "scanned,errors,results",
    [([], [], []), (["other.js"], [], []), (["source.js"], [{}], []), (["source.js"], [], [{}])],
)
def test_native_semgrep_cannot_omit_source_or_hide_errors(repository, tmp_path, scanned, errors, results):
    root = repository({"source.js": "const result = 1;\n"})
    log = tmp_path / "scanner.json"
    log.write_text(
        json.dumps(
            {"version": "fixture", "paths": {"scanned": scanned}, "errors": errors, "results": results}
        )
    )
    with pytest.raises(Invalid):
        security.verify_semgrep(root, {"paths": ["source.js"]}, log)
