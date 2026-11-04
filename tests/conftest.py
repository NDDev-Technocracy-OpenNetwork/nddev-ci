import subprocess

import pytest


@pytest.fixture(autouse=True)
def isolate_host_cache_provider(monkeypatch):
    """Unit fixtures never borrow the executing host's private cache scope."""
    monkeypatch.delenv("NDDEV_CACHE_PROVIDER", raising=False)
    monkeypatch.delenv("NDDEV_UV_CENTRAL_INDEX", raising=False)


@pytest.fixture
def repository(tmp_path):
    root = tmp_path / "caller"
    root.mkdir()

    def commit(files: dict[str, str]):
        for name, text in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        for args in (
            ["init", "-b", "main"],
            ["config", "user.name", "Fixture"],
            ["config", "user.email", "fixture@example.invalid"],
            ["add", "."],
            ["commit", "-qm", "fixture"],
        ):
            subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)
        return root

    return commit
