"""Execute optional quality tools and reject controlled findings with their real native outputs."""

import json
import os
import subprocess
import sys

from native_advanced import project

from nddev_cicd import advanced, ci, config
from nddev_cicd.model import git
from nddev_cicd.process import run


def test_actual_offline_semgrep_rejects_javascript_and_python_findings(repository, tmp_path, monkeypatch):
    executable = sys.executable.replace("\\", "/")
    root = repository(
        {
            "README.md": "# Native source-quality fixture\n",
            ".gitignore": ".nddev-reports/\n",
            "source.js": "const result = 'safe';\n",
            "source.py": "result = 'safe'\n",
            "rules.yml": "rules:\n- id: reject-python-eval\n  languages: [python]\n  pattern: eval($INPUT)\n  message: Do not execute input as code\n  severity: ERROR\n- id: reject-javascript-eval\n  languages: [javascript]\n  pattern: eval($INPUT)\n  message: Do not execute input as code\n  severity: ERROR\n",
            ".github/nddev-ci.toml": f'''schema=1
profiles=["documentation"]
[commands.documentation]
external-links=["{executable}","-c","print('native fixture')"]
generate=["{executable}","-c","print('native fixture')"]
examples=["{executable}","-c","print('native fixture')"]
[security]
engine="semgrep"
rules=["rules.yml"]
paths=["source.js","source.py"]
[extras.sast]
purpose="Exercise actual local Semgrep CE rules without an account or external rule service"
command=["@library","security-sast"]
timeout=120
''',
        }
    )
    # An inherited account must not participate in this explicitly offline OSS operation.
    monkeypatch.setenv("SEMGREP_APP_TOKEN", "not-a-real-account-token")
    positive = ci.execute(root, config.load(root), tmp_path / "positive")
    assert positive["status"] == "success"
    scanned = next(x for x in positive["results"] if x["name"] == "extra.sast")
    assert scanned["sast_targets"] == 2
    settings = (tmp_path / "positive/semgrep-settings.yml").read_text()
    assert "not-a-real-account-token" not in settings
    assert os.environ["SEMGREP_APP_TOKEN"] == "not-a-real-account-token"
    (root / "source.js").write_text("const result = eval(input);\n")
    (root / "source.py").write_text("result = eval(input)\n")
    negative = ci.execute(root, config.load(root), tmp_path / "negative")
    assert "extra.sast" in negative["failed"]
    findings = json.loads((tmp_path / "negative/extra-sast.log").read_text())["results"]
    assert {x["path"] for x in findings} == {"source.py", "source.js"}


def test_actual_mutmut_requires_caught_mutants_and_rejects_weakened_tests(repository, tmp_path):
    root = project(repository, "mutation-python")
    original = (root / "src/example.py").read_bytes()
    positive = advanced.mutation(root, tmp_path / "positive", engine="mutmut")
    assert positive["status"] == "success" and positive["caught"] > 0 and positive["missed"] == 0
    assert (root / "src/example.py").read_bytes() == original and not (root / "mutants").exists()
    (root / "tests/test_example.py").write_text(
        "from example import add_one\n\ndef test_actual_addition():\n    assert add_one(2) is not None\n"
    )
    git(root, "add", ".")
    git(root, "commit", "-qm", "controlled weak mutation test")
    negative = advanced.mutation(root, tmp_path / "negative", engine="mutmut")
    assert negative["status"] == "failure" and negative["missed"] > 0
    assert (tmp_path / "negative/mutants/mutmut-cicd-stats.json").is_file()


def test_actual_stryker_requires_native_completed_mutants(repository, tmp_path):
    root = project(repository, "mutation-node")
    subprocess.run(
        ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    original = (root / "src/add.js").read_bytes()
    positive = advanced.mutation(root, tmp_path / "positive", engine="stryker")
    assert positive["status"] == "success" and positive["caught"] > 0 and positive["missed"] == 0
    assert (root / "src/add.js").read_bytes() == original
    (root / "test/add.test.js").write_text(
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { addOne } from '../src/add.js';\ntest('weak property',()=>assert.equal(typeof addOne(2),'number'));\n"
    )
    git(root, "add", ".")
    git(root, "commit", "-qm", "controlled weak JavaScript mutation test")
    negative = advanced.mutation(root, tmp_path / "negative", engine="stryker")
    assert negative["status"] == "failure" and negative["missed"] > 0
    assert (tmp_path / "negative/stryker-report.json").is_file()
    settings = root / "stryker.config.mjs"
    settings.write_text(settings.read_text().replace("break: null", "break: 100"))
    git(root, "add", ".")
    git(root, "commit", "-qm", "controlled native project threshold")
    stricter = advanced.mutation(root, tmp_path / "native-threshold", engine="stryker", maximum_missed=100)
    assert stricter["status"] == "failure" and stricter["exit_code"] == 1


def test_actual_spelling_tool_rejects_a_controlled_typo(repository, tmp_path):
    root = repository({"README.md": "The algorithm returns one byte.\n"})
    assert run(["typos", "README.md"], root, tmp_path / "positive.log")["status"] == "success"
    (root / "README.md").write_text("The algorthm returns one byte.\n")
    assert run(["typos", "README.md"], root, tmp_path / "negative.log")["status"] == "failure"
    assert "algorthm" in (tmp_path / "negative.log").read_text()


def test_actual_machete_detects_an_unused_local_dependency(repository, tmp_path):
    root = repository(
        {
            "Cargo.toml": '[package]\nname="native-dependency-fixture"\nversion="0.1.0"\nedition="2021"\nlicense="AGPL-3.0-only"\n[dependencies]\nnative-used={path="used"}\n',
            "src/lib.rs": "pub fn value() -> u8 { native_used::value() }\n",
            "used/Cargo.toml": '[package]\nname="native-used"\nversion="0.1.0"\nedition="2021"\nlicense="AGPL-3.0-only"\n',
            "used/src/lib.rs": "pub fn value() -> u8 { 1 }\n",
        }
    )
    subprocess.run(["cargo", "generate-lockfile", "--offline"], cwd=root, check=True, capture_output=True)
    assert (
        run(["cargo", "machete", "--with-metadata"], root, tmp_path / "positive.log")["status"] == "success"
    )
    (root / "unused/src").mkdir(parents=True)
    (root / "unused/Cargo.toml").write_text(
        '[package]\nname="native-unused"\nversion="0.1.0"\nedition="2021"\nlicense="AGPL-3.0-only"\n'
    )
    (root / "unused/src/lib.rs").write_text("pub fn value() -> u8 { 2 }\n")
    with (root / "Cargo.toml").open("a") as stream:
        stream.write('native-unused={path="unused"}\n')
    subprocess.run(["cargo", "generate-lockfile", "--offline"], cwd=root, check=True, capture_output=True)
    assert (
        run(["cargo", "machete", "--with-metadata"], root, tmp_path / "negative.log")["status"] == "failure"
    )
    assert "native-unused" in (tmp_path / "negative.log").read_text()
