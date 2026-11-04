from pathlib import Path

import yaml

ACTION = Path(__file__).resolve().parents[1] / ".github" / "actions" / "source-release" / "action.yml"


def _action():
    return yaml.safe_load(ACTION.read_text(encoding="utf-8"))


def test_inputs_cover_the_retired_reusable_contract():
    inputs = _action()["inputs"]
    assert inputs["version"]["required"] is True
    assert inputs["package-name"]["required"] is True
    for name in ("archive-paths", "runtime-paths", "notes-file", "attest", "github-token"):
        assert name in inputs
    assert inputs["attest"]["default"] == "auto"


def test_every_attestation_is_guarded_by_the_mode():
    steps = _action()["runs"]["steps"]
    assert steps[0]["id"] == "mode"
    attest = [step for step in steps if step.get("name", "").startswith("Attest")]
    assert len(attest) == 3
    assert all("steps.mode.outputs.attest == 'true'" in step["if"] for step in attest)


def test_composite_steps_are_shell_explicit_and_pinned():
    for step in _action()["runs"]["steps"]:
        if "run" in step:
            assert step["shell"] == "bash"
        if "uses" in step:
            reference = step["uses"].split("@", 1)[1]
            assert len(reference) == 40 and all(c in "0123456789abcdef" for c in reference)


def test_release_is_created_once_with_a_verified_tag():
    runs = "\n".join(step.get("run", "") for step in _action()["runs"]["steps"])
    assert runs.count("release create") == 1
    assert "--verify-tag" in runs
    assert "--clobber" not in runs
    assert "ci-workflows" not in runs


def test_the_action_never_checks_out_code_itself():
    steps = _action()["runs"]["steps"]
    assert not any(str(step.get("uses", "")).startswith("actions/checkout@") for step in steps)
    assert any("refs/tags/${RELEASE_VERSION}^{commit}" in step.get("run", "") for step in steps)
