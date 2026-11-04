"""Mechanical text scopes preserve native data and report only actual coverage."""

import pytest

from nddev_cicd import documentation
from nddev_cicd.model import Invalid, git


@pytest.mark.parametrize(
    "text,category",
    [
        ("An authored sentence\u2014with punctuation.\n", "decorative-prose"),
        ("A result \u2705\n", "decorative-prose"),
        ("Project version: 1.2.3\n", "release-value"),
        ("The chosen release is 1.2.3.\n", "release-value"),
        ("<!-- Version: 1.2.3 -->\n", "release-value"),
        ("```yaml\nimage: example/app@sha256:" + "a" * 64 + "\n```\n", "fingerprint"),
        ("Fingerprint: " + "b" * 40 + "\n", "fingerprint"),
        ("All 184 tests are passing on the latest build.\n", "transient-claim"),
    ],
)
def test_authored_identity_cannot_escape_in_comments_or_fences(repository, text, category):
    root = repository({"README.md": text})
    with pytest.raises(Invalid, match=category) as failure:
        documentation.check(root, {"style": {"authored": ["README.md"]}})
    assert "1.2.3" not in str(failure.value) and "a" * 40 not in str(failure.value)


def test_native_parser_scopes_and_literal_operators(repository):
    root = repository(
        {
            "README.md": "# Project\n\nFollow STD-0001 and R-0003; distance is 1.25 m.\n\n"
            "```sh\ngit diff --stat\n```\n\n[Native source](https://example.invalid/v1.2.3).\n",
            "example.yaml": "image: example/app@sha256:" + "a" * 64 + "\n",
            "tests/fixtures/original.md": "# Original\n\nRelease 1.2.3\n",
            "archive/original.md": "# Original\n\nAn earlier sentence\u2014retained.\n",
            "LICENSE.md": "License release 1.2.3\n",
            "generated/index.md": "# Index\n\n[Project](../README.md#project).\n",
        }
    )
    before = (root / "example.yaml").read_bytes()
    scope = {
        "authored": ["README.md"],
        "generated": ["generated/*.md"],
        "literal": ["tests/fixtures/*.md"],
        "historical": ["archive/*.md"],
        "legal": ["LICENSE.md"],
    }
    report = documentation.check(root, {"style": scope})
    assert report["style"]["files"] == 2 and report["style"]["preserved"] == 3
    assert (root / "example.yaml").read_bytes() == before


@pytest.mark.parametrize(
    "scope",
    [
        {"authored": ["missing.md"]},
        {"literal": ["README.md"]},
        {"historical": ["README.md"]},
        {"legal": ["README.md"]},
        {"unknown": ["README.md"]},
        {"authored": ["README.md"], "generated": ["README.md"]},
        {"authored": ["../README.md"]},
    ],
)
def test_empty_or_conflicting_scope_is_not_success(repository, scope):
    root = repository({"README.md": "# Project\n\nAn explanation.\n"})
    with pytest.raises(Invalid):
        documentation.check(root, {"style": scope})


def test_unclassified_markdown_is_not_an_active_allowlist(repository):
    root = repository({"README.md": "# Project\n", "docs/domain.md": "A domain.\n"})
    with pytest.raises(Invalid, match="unclassified"):
        documentation.check(root, {"style": {"authored": ["README.md"]}})
    assert documentation.check(root)["style"]["status"] == "not-selected"


def test_reference_links_images_and_anchors_use_native_tokens(repository):
    root = repository(
        {
            "README.md": "# Project\n\n[Guide][entry]\n\n[entry]: docs/guide.md#guide\n\n![result](image.svg)\n",
            "docs/guide.md": "# Guide\n\n## Same\n\n## Same\n\n[Duplicate](#same-1)\n",
            "image.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
        }
    )
    assert documentation.check(root)["local_links"] == 3
    (root / "docs/guide.md").write_text("# Different\n")
    with pytest.raises(Invalid, match="anchor"):
        documentation.check(root)


def test_fenced_code_does_not_invent_a_document_link(repository):
    root = repository({"README.md": "# Project\n\n```md\n[example](missing.md)\n```\n"})
    assert documentation.check(root)["local_links"] == 0
    assert documentation.style_check(root, git(root, "ls-files", "-z").split("\0"), None) == {
        "status": "not-selected"
    }


def test_native_relative_link_identity_is_not_copied_prose(repository):
    root = repository(
        {
            "README.md": "# Project\n\n[Historical source](archive/release-1.2.3.md).\n",
            "archive/release-1.2.3.md": "# Issued text\n\nRelease 1.2.3\n",
        }
    )
    scope = {"authored": ["README.md"], "historical": ["archive/*.md"]}
    assert documentation.check(root, {"style": scope})["style"]["status"] == "success"
    (root / "README.md").write_text('# Project\n\n[Source](archive/release-1.2.3.md "Version 1.2.3").\n')
    with pytest.raises(Invalid, match="release-value"):
        documentation.check(root, {"style": scope})


def test_style_guidance_can_name_freshness_terms_without_asserting_freshness(repository):
    root = repository({"README.md": "# Writing\n\nA last-reviewed date does not establish truth.\n"})
    assert documentation.check(root, {"style": {"authored": ["README.md"]}})["style"]["status"] == "success"
    (root / "README.md").write_text("# Project\n\nLast reviewed: 2026-10-19\n")
    with pytest.raises(Invalid, match="transient-claim"):
        documentation.check(root, {"style": {"authored": ["README.md"]}})


def test_native_adr_metadata_is_data_but_body_and_comments_keep_full_style_coverage(repository):
    metadata = "---\nstatus: accepted\nadaptation:\n  standard: {id: std-0004, version: 0.3.3}\n  rules: [R-0004]\n---\n"
    root = repository({"docs/decisions/native.md": metadata + "# Native route\n\nUse the selected host.\n"})
    scope = {"authored": ["docs/decisions/*.md"]}
    assert documentation.check(root, {"style": scope})["style"]["files"] == 1
    path = root / "docs/decisions/native.md"
    for body in ("Release 1.2.3\n", "<!-- release 1.2.3 -->\n", "```yaml\nversion: 1.2.3\n```\n"):
        path.write_text(metadata + body)
        with pytest.raises(Invalid, match=r"native.md:7: release-value"):
            documentation.check(root, {"style": scope})


@pytest.mark.parametrize("metadata", ["owner: one\nowner: two\n", "adaptation: [unterminated\n"])
def test_native_markdown_metadata_errors_do_not_leak_source_or_pass(repository, metadata):
    root = repository({"README.md": "---\n" + metadata + "---\n# Project\n"})
    with pytest.raises(Invalid, match="Invalid Markdown YAML front matter") as failure:
        documentation.check(root)
    assert "unterminated" not in str(failure.value) and "owner: two" not in str(failure.value)


def test_thematic_break_is_not_an_unchecked_prose_container(repository):
    root = repository({"README.md": "---\nRelease 1.2.3\n---\n# Project\n"})
    with pytest.raises(Invalid, match="release-value"):
        documentation.check(root, {"style": {"authored": ["README.md"]}})


def test_retired_replacement_pin_is_native_data_without_rewriting_source(repository):
    text = "# History\n\n```item\nstatus: retired\nreplaced-by: example-core@8.4.2#R-9001\n```\n"
    root = repository({"README.md": text})
    before = (root / "README.md").read_bytes()
    assert documentation.check(root, {"style": {"authored": ["README.md"]}})["style"]["status"] == "success"
    assert (root / "README.md").read_bytes() == before


@pytest.mark.parametrize(
    "metadata,language,tail",
    [
        ("status: active\nreplaced-by: example-core@8.4.2#R-9001\n", "item", ""),
        ("kind: retired\nreplaced-by: example-core@8.4.2#R-9001\n", "item", ""),
        ("status: retired\nreplaced-by: example-core@8.4.2\n", "item", ""),
        ("status: retired\nreplaced-by: example-core@8.4.2#R-9001\n", "yaml", ""),
        ("status: retired\nreplaced-by: example-core@8.4.2#R-9001 # copied release 3.2.1\n", "item", ""),
        ("status: retired\nreplaced-by: example-core@8.4.2#R-9001\nrelease: 3.2.1\n", "item", ""),
        ("status: retired\nstatus: active\nreplaced-by: example-core@8.4.2#R-9001\n", "item", ""),
        ("status: retired\npin: &pin example-core@8.4.2#R-9001\nreplaced-by: *pin\n", "item", ""),
        ("status: retired\nreplaced-by: example-core@8.4.2#R-9001\n", "item", "Copied release 3.2.1.\n"),
    ],
)
def test_replacement_data_cannot_hide_copied_or_unrecognized_identity(repository, metadata, language, tail):
    root = repository({"README.md": "# History\n\n```" + language + "\n" + metadata + "```\n" + tail})
    with pytest.raises(Invalid, match="release-value"):
        documentation.check(root, {"style": {"authored": ["README.md"]}})


@pytest.mark.parametrize("quote", ["", "'", chr(34)])
def test_replacement_scalar_quoting_keeps_the_same_data_boundary(repository, quote):
    metadata = "status: retired\nreplaced-by: " + quote + "example-core@8.4.2#R-9001" + quote + "\n"
    root = repository({"README.md": "# History\n\n```item\n" + metadata + "```\n"})
    assert documentation.check(root, {"style": {"authored": ["README.md"]}})["style"]["status"] == "success"
