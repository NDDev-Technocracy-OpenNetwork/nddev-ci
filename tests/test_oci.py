"""Validate cache/build arguments before any builder, registry or source mutation."""

import json

import pytest

from nddev_cicd import ci, config, oci
from nddev_cicd.model import Invalid, Unavailable


@pytest.mark.parametrize(
    "argument", ["TOKEN=value", "PASSWORD=value", "NAME", "1NAME=value", "NAME=one\nother", "NAME=\0"]
)
def test_build_arguments_are_explicit_nonsecret_native_data(tmp_path, argument):
    with pytest.raises(Invalid):
        oci.build_options(tmp_path, [argument], [], [])


def test_duplicate_arguments_and_cache_keys_are_not_silently_replaced(tmp_path):
    with pytest.raises(Invalid):
        oci.build_options(tmp_path, ["MODE=one", "MODE=two"], [], [])
    with pytest.raises(Invalid):
        oci.build_options(tmp_path, [], ["type=local,src=cache,src=other"], [])


@pytest.mark.parametrize(
    "cache",
    [
        "type=local,src=../outside",
        "type=local,src=.",
        "type=gha,scope=fixture,url=https://example.invalid",
        "type=registry,ref=user:password@example.invalid/cache",
        "type=registry,ref=registry.example.invalid/cache,ignore-error=true",
    ],
)
def test_cache_paths_and_credentials_cannot_override_the_native_boundary(tmp_path, cache):
    with pytest.raises(Invalid):
        oci.build_options(tmp_path, [], [cache], [])


def test_type_key_order_cannot_bypass_local_export_ownership(tmp_path, monkeypatch):
    # This checks local ownership; dedicated PR fixtures check provider write authority.
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    flags = oci.build_options(tmp_path, [], [], ["dest=cache,type=local"])
    assert oci.local_exports(flags) == [tmp_path / "cache"]
    (tmp_path / "cache").mkdir()
    original = tmp_path / "cache/index.json"
    original.write_text("existing source or foreign cache")
    with pytest.raises(Invalid, match="unowned"):
        oci.own_export(tmp_path, tmp_path / "cache")
    assert original.read_text() == "existing source or foreign cache"


@pytest.mark.parametrize(
    "cache", ["type=registry,ref=registry.example.invalid/fixture:cache", "type=local,dest=cache"]
)
def test_pr_context_cannot_write_caches(tmp_path, monkeypatch, cache):
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_REF", "refs/pull/1/merge")
    with pytest.raises(Invalid, match="read-only"):
        oci.build_options(tmp_path, [], [], [cache])


def test_gha_requires_native_v2_runtime_without_endpoint_or_token_overrides(tmp_path, monkeypatch):
    monkeypatch.delenv("ACTIONS_RUNTIME_TOKEN", raising=False)
    monkeypatch.delenv("ACTIONS_RESULTS_URL", raising=False)
    with pytest.raises(Unavailable):
        oci.build_options(tmp_path, [], ["type=gha,scope=fixture-linux-amd64"], [])
    monkeypatch.setenv("ACTIONS_RUNTIME_TOKEN", "native-fixture-token")
    monkeypatch.setenv("ACTIONS_RESULTS_URL", "https://results.actions.githubusercontent.com")
    flags = oci.build_options(tmp_path, [], ["type=gha,scope=fixture-linux-amd64"], [])
    assert "version=2" in flags[-1] and "timeout=60s" in flags[-1]
    assert "native-fixture-token" not in str(flags)


def test_cache_writes_use_native_caller_default_branch(tmp_path, monkeypatch):
    payload = tmp_path / "event.json"
    payload.write_text(
        json.dumps({"repository": {"full_name": "example/fixture", "default_branch": "stable"}})
    )
    for name, value in {
        "GITHUB_ACTIONS": "true",
        "GITHUB_EVENT_NAME": "push",
        "GITHUB_REPOSITORY": "example/fixture",
        "GITHUB_EVENT_PATH": str(payload),
        "GITHUB_REF": "refs/heads/stable",
    }.items():
        monkeypatch.setenv(name, value)
    assert oci.build_options(tmp_path, [], [], ["type=local,dest=cache"])
    monkeypatch.setenv("GITHUB_REF", "refs/heads/other")
    with pytest.raises(Invalid):
        oci.build_options(tmp_path, [], [], ["type=local,dest=cache"])


def test_project_contract_cannot_override_native_cache_authority(repository, tmp_path):
    root = repository(
        {
            "README.md": "# Native context fixture\n",
            ".github/nddev-ci.toml": 'schema=1\nprofiles=["documentation"]\n[environment]\nGITHUB_REF="refs/heads/main"\n',
        }
    )
    with pytest.raises(Invalid, match="context"):
        ci.execute(root, config.load(root), tmp_path / "output")


def test_cache_marker_cannot_turn_tracked_source_into_an_export(repository):
    root = repository({"cache/index.json": "tracked source"})
    (root / "cache/.nddev-buildcache-owner.json").write_text(
        json.dumps({"schema": 1, "owner": "nddev-cicd-buildcache", "project": str(root.resolve())})
    )
    with pytest.raises(Invalid, match="tracked"):
        oci.own_export(root, root / "cache")
    assert (root / "cache/index.json").read_text() == "tracked source"
