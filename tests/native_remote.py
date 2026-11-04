"""Actual SSH/SCP acceptance against a separate filesystem/server with its own target lock."""

import concurrent.futures
import urllib.request
from pathlib import Path

import pytest
import ssh_fixture

from nddev_cicd import artifacts, remote
from nddev_cicd.model import Invalid, git, source_identity


def test_native_ssh_delivery_host_identity_and_shared_target_lock(repository, tmp_path):
    fixture = ssh_fixture.start(tmp_path / "ssh keys")
    try:
        assert not Path(fixture["target"]).exists()
        root = repository({"input": "first"})
        public = root / "public"
        public.mkdir()
        source = source_identity(root)
        (public / "index.html").write_text(source["tested_revision"])
        archive = tmp_path / "first.tar.gz"
        manifest = artifacts.pack(root, ["public/index.html"], archive, source)
        settings = {
            "module": "static-web",
            "target_directory": fixture["target"],
            "generation": 1,
            "expected_previous": None,
            "entrypoint": "public/index.html",
            "health_url": "http://127.0.0.1:8080/current/public/index.html",
        }
        settings["backup_command"] = [
            "python3",
            "-c",
            "import os; assert os.environ['SCOPED_VALUE']=='fixture-only'; assert 'GITHUB_TOKEN' not in os.environ",
        ]
        result = remote.apply(
            archive,
            manifest,
            source,
            settings,
            fixture["transport"],
            authorized=True,
            environment={"SCOPED_VALUE": "fixture-only"},
        )
        assert result["status"] == "success" and result["transport"] == "ssh"
        with urllib.request.urlopen(
            fixture["http_url"] + "/current/public/index.html", timeout=5
        ) as response:
            assert response.read().decode() == source["tested_revision"]
        with pytest.raises(Invalid, match="Stale deployment"):
            remote.apply(archive, manifest, source, settings, fixture["transport"], authorized=True)
        # Wrong pinned host key must fail authentication before any remote adapter runs.
        wrong = tmp_path / "wrong_known_hosts"
        wrong.write_text(
            Path(fixture["transport"]["known_hosts"])
            .read_text()
            .replace(
                ssh_fixture.output("ssh-keygen", "-y", "-f", str(tmp_path / "ssh keys/hostkey")),
                ssh_fixture.output("ssh-keygen", "-y", "-f", str(tmp_path / "ssh keys/client")),
            )
        )
        wrong.chmod(0o600)
        with pytest.raises(Invalid, match="SSH operation stage failed"):
            remote.apply(
                archive,
                manifest,
                source,
                settings,
                {**fixture["transport"], "known_hosts": str(wrong)},
                authorized=True,
            )
        (root / "input").write_text("second")
        git(root, "add", "input")
        git(root, "commit", "-qm", "second candidate")
        second_source = source_identity(root)
        (public / "index.html").write_text(second_source["tested_revision"])
        second = tmp_path / "second.tar.gz"
        second_manifest = artifacts.pack(root, ["public/index.html"], second, second_source)
        settings.update(
            generation=2,
            expected_previous=manifest["artifact_identity"],
            backup_command=["python3", "-c", "import time; time.sleep(1)"],
        )

        def attempt():
            try:
                return remote.apply(
                    second, second_manifest, second_source, settings, fixture["transport"], authorized=True
                )["status"]
            except Invalid as error:
                assert "Stale deployment" in str(error)
                return "stale"

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(lambda _: attempt(), range(2))) == ["stale", "success"]
        with urllib.request.urlopen(
            fixture["http_url"] + "/current/public/index.html", timeout=5
        ) as response:
            assert response.read().decode() == second_source["tested_revision"]
        corrupt = tmp_path / "corrupt.tar.gz"
        corrupt.write_bytes(second.read_bytes() + b"corruption")
        with pytest.raises(Invalid, match="digest/schema"):
            remote.apply(
                corrupt, second_manifest, second_source, settings, fixture["transport"], authorized=True
            )
        (root / "input").write_text("third")
        git(root, "add", "input")
        git(root, "commit", "-qm", "third candidate")
        third_source = source_identity(root)
        (public / "index.html").write_text(third_source["tested_revision"])
        third = tmp_path / "third.tar.gz"
        third_manifest = artifacts.pack(root, ["public/index.html"], third, third_source)
        settings.update(
            generation=3,
            expected_previous=second_manifest["artifact_identity"],
            backup_command=[
                "python3",
                "-c",
                "from pathlib import Path; Path('backup.txt').write_text('initial')",
            ],
            data_migration=[
                "python3",
                "-c",
                f"from pathlib import Path; p=Path({fixture['target']!r})/'migration.log'; p.open('a').write('applied\\n')",
            ],
            health_contains="deliberately absent scenario",
        )
        with pytest.raises(Invalid, match="scenario/version"):
            remote.apply(third, third_manifest, third_source, settings, fixture["transport"], authorized=True)
        recovered = remote.apply(
            third,
            third_manifest,
            third_source,
            {**settings, "health_contains": third_source["tested_revision"], "recover_partial": True},
            fixture["transport"],
            authorized=True,
        )
        assert recovered["status"] == "success" and recovered["generation"] == 3
        with urllib.request.urlopen(fixture["http_url"] + "/migration.log", timeout=5) as response:
            assert response.read() == b"applied\n"
        assert not Path(fixture["target"]).exists()
    finally:
        ssh_fixture.stop(tmp_path / "ssh keys")
