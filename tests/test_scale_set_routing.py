"""Official scale-set routing remains explicit, private and incapable of provider fallback."""

import pytest

from nddev_cicd import routing
from nddev_cicd.model import Invalid, Unavailable


def policy(**replace):
    return {
        "self_hosted": {
            "kind": "scale-set",
            "name": "fixture-pool",
            "group": "Default",
            "platform": "linux",
            "architecture": "x64",
            "guarantee": "self-hosted-only",
            "reference": "owner-verified-native-inventory",
            **replace,
        }
    }


def test_official_scale_set_uses_its_native_group_and_label_without_classic_labels():
    result = routing.select("private", "linux", trusted=True, admission=policy())
    assert result["provider"] == "self-hosted"
    assert result["runner"] == {"group": "Default", "labels": "fixture-pool"}
    assert result["availability"] == "not-checked"


@pytest.mark.parametrize(
    "replace",
    [
        {"group": ""},
        {"name": ""},
        {"reference": ""},
        {"group": "bad\ngroup"},
        {"platform": "windows"},
        {"architecture": "arm64"},
        {"guarantee": "paid-capable"},
    ],
)
def test_unverified_or_incompatible_scale_set_does_not_select_another_provider(replace):
    with pytest.raises((Invalid, Unavailable)):
        routing.select("private", "linux", trusted=True, admission=policy(**replace))


def test_untrusted_source_and_ambiguous_classic_labels_are_refused():
    with pytest.raises(Unavailable):
        routing.select("private", "linux", admission=policy())
    with pytest.raises(Invalid):
        routing.select(
            "private",
            "linux",
            trusted=True,
            private_labels=["self-hosted", "Linux", "X64"],
            admission=policy(),
        )


def test_public_route_never_uses_a_private_scale_set():
    result = routing.select("public", "linux", admission=policy())
    assert result["runner"] == ["ubuntu-26.04"] and result["provider"] == "github"
