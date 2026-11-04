"""Real gitlink/worktree mismatches cannot feed recursive scanners or reusable cached workspaces."""

import json
import sys

import pytest

from nddev_cicd import ci, config, git_inputs
from nddev_cicd.model import Invalid, git


def setup(repository, tmp_path):
    root = repository({"README.md": "# Caller\n"})
    child = tmp_path / "dependency"
    child.mkdir()
    for arguments in (
        ["init", "-b", "main"],
        ["config", "user.name", "Fixture"],
        ["config", "user.email", "fixture@example.invalid"],
    ):
        git(child, *arguments)
    (child / "README.md").write_text("# First\n")
    git(child, "add", ".")
    git(child, "commit", "-qm", "first")
    old = git(child, "rev-parse", "HEAD")
    (child / "README.md").write_text("# Second\n")
    git(child, "commit", "-qam", "second")
    new = git(child, "rev-parse", "HEAD")
    git(
        root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", str(child), "dep with spaces"
    )
    git(root, "commit", "-qam", "pin dependency")
    return root, root / "dep with spaces", old, new


def test_native_submodule_identity_dirty_and_symlink_inputs(repository, tmp_path):
    root, module, old, new = setup(repository, tmp_path)
    assert git_inputs.submodules(root) == {"dep with spaces": new}
    (module / "README.md").write_text("uncommitted source")
    with pytest.raises(Invalid, match="modified"):
        git_inputs.submodules(root)
    (module / "README.md").write_text("# Second\n")
    git(module, "checkout", "--quiet", old)
    with pytest.raises(Invalid, match="gitlink"):
        git_inputs.submodules(root)
    git(module, "checkout", "--quiet", new)
    module.rename(tmp_path / "owned-backup")
    module.symlink_to(tmp_path / "owned-backup", target_is_directory=True)
    with pytest.raises(Invalid, match="symlink"):
        git_inputs.submodules(root)


def test_ci_checks_submodule_inputs_before_and_after_commands(repository, tmp_path):
    root, module, old, new = setup(repository, tmp_path)
    marker = tmp_path / "scanner-started"
    contract = root / ".github/nddev-ci.toml"
    contract.parent.mkdir()
    commands = {
        "external-links": [sys.executable, "-c", f"from pathlib import Path; Path({str(marker)!r}).touch()"],
        "generate": [sys.executable, "-c", "pass"],
        "examples": [sys.executable, "-c", "pass"],
    }

    def write():
        contract.write_text(
            'schema=1\nprofiles=["documentation"]\n[commands.documentation]\n'
            + "\n".join(key + "=" + json.dumps(value) for key, value in commands.items())
        )

    write()
    git(root, "add", ".github")
    git(root, "commit", "-qm", "native caller")
    git(module, "checkout", "--quiet", old)
    failed = ci.execute(root, config.load(root), tmp_path / "stale-result")
    assert failed["status"] == "failure" and not marker.exists()
    assert failed["failed"] == ["inputs.submodule-integrity"]
    git(module, "checkout", "--quiet", new)
    passed = ci.execute(root, config.load(root), tmp_path / "correct-result")
    assert passed["status"] == "success" and marker.exists()
    commands["generate"] = ["git", "-C", str(module), "checkout", "--quiet", old]
    write()
    failed = ci.execute(root, config.load(root), tmp_path / "changed-result")
    assert failed["status"] == "failure"
    integrity = next(row for row in failed["results"] if row["name"] == "inputs.lock-integrity")
    assert "submodules" in integrity["changed_inputs"]
