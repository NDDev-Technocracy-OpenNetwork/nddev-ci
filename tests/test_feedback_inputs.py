"""Input classification reads bounded metadata without inspecting arbitrary test output."""

from nddev_cicd import feedback


def test_only_owned_typed_annotations_produce_input_hints(monkeypatch):
    calls = []

    def get(path):
        calls.append(path)
        return [
            {
                "title": "NDDev infrastructure input",
                "message": "infrastructure.external-download: bounded fetch",
            },
            {"title": "NDDev infrastructure input", "message": "test.failed: assertion"},
            {"title": "arbitrary test", "message": "infrastructure.external-download: arbitrary stdout"},
            {"title": "NDDev infrastructure input", "message": None},
        ]

    monkeypatch.setattr(feedback.github, "get", get)
    result = feedback.input_hints(
        "example/project", {"check_run_url": "https://api.github.com/repos/example/project/check-runs/123"}
    )
    assert result == ["infrastructure.external-download"]
    assert calls == ["repos/example/project/check-runs/123/annotations?per_page=100"]
    assert (
        feedback.input_hints("example/project", {"check_run_url": "https://foreign.invalid/check-runs/123"})
        == []
    )
    assert len(calls) == 1


def test_unavailable_annotation_access_does_not_invent_infrastructure_failure(monkeypatch):
    from urllib.error import HTTPError

    def forbidden(_):
        raise HTTPError("https://api.github.com", 403, "not granted", None, None)

    monkeypatch.setattr(feedback.github, "get", forbidden)
    assert (
        feedback.input_hints(
            "example/project",
            {"check_run_url": "https://api.github.com/repos/example/project/check-runs/123"},
        )
        == []
    )
