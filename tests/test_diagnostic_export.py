"""The action's directory export includes sanitized diagnostics and unchanged payloads."""

import hashlib
import json
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
import yaml

from nddev_cicd import artifacts, ci, config, diagnostic_export, reports
from nddev_cicd.model import Invalid
from nddev_cicd.process import run

CONTRACT = """schema=1
profiles=["documentation"]
[commands.documentation]
external-links=["git","diff","--exit-code"]
generate=["git","diff","--exit-code"]
examples=["git","diff","--exit-code"]
"""


def test_action_upload_requires_completed_export_preparation():
    action = yaml.safe_load((Path(__file__).parents[1] / ".github/actions/ci/action.yml").read_text())
    steps = action["runs"]["steps"]
    upload = next(step for step in steps if step.get("id") == "upload")
    prepared = next(step for step in steps if step.get("id") == "diagnostics")
    assert upload["with"]["path"] == "${{ steps.native.outputs.directory }}"
    assert "steps.diagnostics.outcome == 'success'" in upload["if"]
    assert "!cancelled()" in upload["if"]
    assert ".diagnostics-ready" in prepared["run"]


@pytest.mark.parametrize("exit_code", [0, 1])
def test_actual_directory_contains_safe_diagnostics_and_unchanged_payload(
    repository, tmp_path, monkeypatch, exit_code, capsys
):
    sentinel = 'synthetic-<&"-value'
    monkeypatch.setenv("FIXTURE_SECRET", sentinel)
    root = repository({"README.md": "# Fixture\n", ".github/nddev-ci.toml": CONTRACT})
    contract = config.load(root)
    contract["commands"]["documentation"]["examples"] = [
        sys.executable,
        "-c",
        f"import os,sys; print('useful evidence'); print(os.environ['FIXTURE_SECRET']); sys.exit({exit_code})",
    ]
    output = tmp_path / "result"
    result = ci.execute(root, contract, output)
    assert result["status"] == ("success" if exit_code == 0 else "failure")
    assert (output / ".diagnostics-ready").is_file()
    assert all(sentinel.encode() not in p.read_bytes() for p in output.rglob("*") if p.is_file())
    assert "useful evidence" in (output / "documentation.examples.log").read_text()
    assert sentinel not in capsys.readouterr().out
    assert json.loads((output / "result.json").read_text())["status"] == result["status"]

    # These bytes are application payload even when they contain the known value.
    # Packing occurs after CI interpretation/export preparation, as in the real CLI.
    payload = root / "payload.json"
    payload.write_bytes(json.dumps({"application": sentinel}).encode())
    payload.chmod(0o755)
    before = (payload.read_bytes(), payload.stat().st_mode)
    manifest = artifacts.pack(root, [payload.name], output / "artifact.tar.gz", result["identity"])
    artifact_bytes = (output / "artifact.tar.gz").read_bytes()
    artifacts.verify(output / "artifact.tar.gz", manifest, result["identity"])
    assert manifest["files"][payload.name]["sha256"] == hashlib.sha256(before[0]).hexdigest()
    assert (payload.read_bytes(), payload.stat().st_mode) == before
    assert (output / "artifact.tar.gz").read_bytes() == artifact_bytes


@pytest.mark.parametrize("extension", ["xml", "json"])
def test_native_report_is_parsed_before_redaction_and_original_is_preserved(tmp_path, extension):
    sentinel = 'synthetic-<&"-value'
    root = tmp_path / "caller"
    root.mkdir()
    original = root / ("report." + extension)
    if extension == "xml":
        node = ET.Element("testsuite")
        ET.SubElement(node, "testcase", name=sentinel)
        original.write_bytes(ET.tostring(node))
    else:
        original.write_text(json.dumps({"message": sentinel}))
    before = original.read_bytes()
    output = tmp_path / "export"
    output.mkdir()
    with diagnostic_export.prepare(output, {"TEST_SECRET": sentinel}):
        reports.retain(root, {"path": original.name}, output / "native-reports")
        if extension == "xml":
            assert reports.tests(root, {"path": original.name}, original) == 1
        assert original.read_bytes() == before
    (retained,) = (output / "native-reports").iterdir()
    if extension == "xml":
        assert ET.parse(retained).getroot().find("testcase").get("name") == "***"
    else:
        assert json.loads(retained.read_text())["message"] == "***"
    assert original.read_bytes() == before


@pytest.mark.parametrize("exception", [Invalid, KeyboardInterrupt])
def test_exception_and_cache_finalizer_diagnostics_are_sanitized_without_success(
    repository, tmp_path, monkeypatch, exception
):
    sentinel = "synthetic-finalizer-value"
    root = repository({"README.md": "# Fixture\n", ".github/nddev-ci.toml": CONTRACT})
    monkeypatch.setenv("TEST_TOKEN", sentinel)
    output = tmp_path / "export"

    def fail(_root, _contract, directory):
        try:
            raise exception("native execution failed")
        finally:
            result = run(
                [
                    sys.executable,
                    "-c",
                    (
                        "import os,sys; print(os.environ['TEST_TOKEN']); "
                        "print('cache finalizer failure '+os.environ['TEST_TOKEN'],file=sys.stderr); sys.exit(1)"
                    ),
                ],
                root,
                directory / "cache.log",
                stderr_log=directory / "cache.stderr.log",
            )
            assert result["status"] == "failure"

    monkeypatch.setattr(ci, "_execute_cached", fail)
    with pytest.raises(exception):
        ci.execute(root, config.load(root), output)
    assert (output / ".diagnostics-ready").is_file()
    assert not (output / "result.json").exists()
    assert "cache finalizer failure ***" in (output / "cache.stderr.log").read_text()
    assert all(sentinel.encode() not in p.read_bytes() for p in output.rglob("*") if p.is_file())


def test_export_failure_never_authorizes_upload_and_does_not_touch_unregistered_bytes(tmp_path, monkeypatch):
    output = tmp_path / "export"
    output.mkdir()
    binary = output / "application.bin"
    binary.write_bytes(b"\0synthetic-value\xff")
    text_payload = output / "application.json"
    text_payload.write_text('{"application":"synthetic-value"}')
    before = {p: (p.read_bytes(), p.stat().st_mode) for p in (binary, text_payload)}
    with (
        pytest.raises(OSError, match="export write failed"),
        diagnostic_export.prepare(output, {"TEST_SECRET": "synthetic-value"}),
    ):
        log = output / "native.log"
        log.write_text("synthetic-value")
        diagnostic_export.register(log)
        monkeypatch.setattr(
            diagnostic_export,
            "_sanitize",
            lambda *args: (_ for _ in ()).throw(OSError("export write failed")),
        )
    assert not (output / ".diagnostics-ready").exists()
    assert {p: (p.read_bytes(), p.stat().st_mode) for p in before} == before


def test_registered_diagnostic_escape_preserves_external_bytes_and_blocks_upload(tmp_path):
    output = tmp_path / "export"
    output.mkdir()
    external = tmp_path / "external.log"
    external.write_text("synthetic-value")
    alias = output / "native.log"
    try:
        alias.symlink_to(external)
    except OSError:
        pytest.skip("native symlink creation unavailable")
    with (
        pytest.raises(ValueError, match="escapes"),
        diagnostic_export.prepare(output, {"TEST_SECRET": "synthetic-value"}),
    ):
        diagnostic_export.register(alias)
    assert external.read_text() == "synthetic-value"
    assert not (output / ".diagnostics-ready").exists()
