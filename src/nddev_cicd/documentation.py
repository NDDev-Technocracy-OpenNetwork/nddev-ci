"""Native text/link checks and canonical generation feedback, without prose attestations."""

from __future__ import annotations

import json
import re
from fnmatch import fnmatchcase
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote

import yaml
from markdown_it import MarkdownIt

from .model import Invalid, contained, git


class StrictLoader(yaml.SafeLoader):
    pass


def mapping(loader, node, deep=False):
    # Reject repeated explicit keys before flattening; merge overrides are valid YAML.
    seen = set()
    for key, _ in node.value:
        if key.tag == "tag:yaml.org,2002:merge":
            continue
        name = loader.construct_object(key, deep=deep)
        if name in seen:
            raise Invalid("Duplicate YAML key")
        seen.add(name)
    loader.flatten_mapping(node)
    return yaml.SafeLoader.construct_mapping(loader, node, deep=deep)


StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)


def markdown_body(text: str) -> str:
    """Separate an initial native YAML mapping from prose, retaining source line positions."""
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return text
    end = next((index for index, line in enumerate(lines[1:], 1) if line.strip() == "---"), None)
    if end is None:
        return text
    try:
        metadata = yaml.load("".join(lines[1:end]), Loader=StrictLoader)
    except (yaml.YAMLError, Invalid) as error:
        raise Invalid("Invalid Markdown YAML front matter") from error
    if not isinstance(metadata, dict):
        # A thematic break followed by ordinary Markdown is not structured metadata.
        return text
    return "\n" * (end + 1) + "".join(lines[end + 1 :])


def check(root: Path, settings: dict | None = None) -> dict:
    settings = settings or {}
    exclusions = settings.get("exclude", [])
    paths = git(root, "ls-files", "-z").split("\0")
    checked, links = 0, 0
    style = style_check(root, paths, settings.get("style"))
    for relative in paths:
        if not relative or any(
            Path(relative).match(pattern)
            or (pattern.endswith("/") and Path(relative).is_relative_to(pattern.rstrip("/")))
            for pattern in exclusions
        ):
            continue
        path = root / relative
        if not path.is_file() or path.suffix.lower() not in {".md", ".yaml", ".yml", ".json"}:
            continue
        text = path.read_text(encoding="utf-8")
        checked += 1
        if path.suffix in {".json", ".yml", ".yaml"}:
            try:
                if path.suffix == ".json":
                    json.loads(text)
                else:
                    list(yaml.load_all(text, Loader=StrictLoader))
            except (yaml.YAMLError, ValueError, TypeError, Invalid) as error:
                # File identity, not private source excerpts, belongs in shared diagnostics.
                raise Invalid(f"Invalid structured document: {relative} ({type(error).__name__})") from error
        elif path.suffix == ".md":
            for target in markdown_targets(markdown_body(text)):
                if re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith("//"):
                    continue
                pathname, _, fragment = target.partition("#")
                destination = (path.parent / unquote(pathname)).resolve() if pathname else path
                if not destination.is_relative_to(root.resolve()) or not destination.exists():
                    raise Invalid(f"Broken/escaping local link: {relative} -> {target}")
                if fragment and destination.suffix == ".md":
                    anchors = markdown_anchors(destination.read_text(encoding="utf-8"))
                    if unquote(fragment) not in anchors:
                        raise Invalid(f"Broken local anchor: {relative} -> {target}")
                links += 1
    if not checked:
        raise Invalid("Documentation selection matched no text files")
    return {
        "files": checked,
        "style": style,
        "local_links": links,
        "external_links": "Use the selected external-link native command and explicit outage policy",
    }


def generation_clean(root: Path) -> None:
    if git(root, "status", "--porcelain", "--untracked-files=normal"):
        raise Invalid("Canonical generation changed the checkout (including untracked outputs)")


def external_outage(root: Path, settings: dict, operation: dict) -> dict | None:
    """Keep explicitly scoped native transport/access failures unavailable; broken URLs stay failures."""
    report = settings.get("external_link_report")
    if operation.get("status") == "success" or not report:
        return None
    payload = json.loads(contained(root, report, exists=True).read_text())
    if payload.get("unknown") != 0 or payload.get("unsupported", 0) != 0:
        return None
    timeouts = [item for items in payload.get("timeout_map", {}).values() for item in items]
    errors = [item for items in payload.get("error_map", {}).values() for item in items]
    if len(timeouts) != payload.get("timeouts", 0) or len(errors) != payload.get("errors", 0):
        return None
    if not timeouts and not errors:
        return None
    scoped_timeouts = {**settings.get("network_outages", {}), **settings.get("network_timeouts", {})}
    refs = []
    for item in timeouts:
        reference = scoped_timeouts.get(item.get("url"))
        if not isinstance(reference, str) or not reference:
            return None
        refs.append(reference)
    for item in errors:
        url, status = item.get("url"), item.get("status", {})
        code = status.get("code")
        if code is None and status.get("text", "").startswith("Network error:"):
            reference = settings.get("network_outages", {}).get(url)
        else:
            disposition = settings.get("access_outages", {}).get(url, {})
            # Never authorize a missing URL (404) or a general HTTP-error whitelist.
            if code not in {403, 429} or disposition.get("status") != code or not disposition.get("reason"):
                return None
            reference = disposition.get("issue")
        if not isinstance(reference, str) or not reference:
            return None
        refs.append(reference)
    return {
        "status": "unavailable",
        "detail": "Scoped native transport/access failure; URL availability is not established",
        "advisory_outage": {
            "native_reporter": "lychee",
            "urls": sorted({item["url"] for item in [*timeouts, *errors]}),
            "issue_refs": sorted(set(refs)),
        },
    }


_STYLE_ROLES = {"authored", "generated", "historical", "literal", "legal"}
_RELEASE_VALUE = re.compile(r"(?<![\w.])v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?(?!\w|\.\d)")
_FINGERPRINT = re.compile(r"(?<![\w])[a-fA-F0-9]{40,64}(?![\w])")
_URL = re.compile(r"(?:https?|ssh|git)://[^\s<>\"'\])]+")
_FRESHNESS = re.compile(
    r"\b(?:(?:last[- ](?:reviewed|verified|updated)|reviewed[- ](?:at|on)|verified[- ](?:at|on))"
    r"\s*[:=]?\s*[`\"']?\d{4}-\d{2}-\d{2}|all \d+ tests[^\n]*pass|"
    r"(?:on|in) the latest build)\b",
    re.IGNORECASE,
)

_EMOJI = re.compile("[\U0001f300-\U0001faff\u2600-\u27bf]")


def _selected(path: str, pattern: str) -> bool:
    return fnmatchcase(path, pattern) or (pattern.startswith("**/") and fnmatchcase(path, pattern[3:]))


_REPLACEMENT_PIN = re.compile(r"[a-z][a-z0-9-]*@(?P<release>[0-9]+[.][0-9]+[.][0-9]+)#[A-Z][A-Z0-9]*-[0-9]+")


def _retirement_data_text(text: str) -> str:
    """Keep only a retired item's replacement release in its native scalar-data role."""
    try:
        data = yaml.load(text, Loader=StrictLoader)
        node = yaml.compose(text, Loader=StrictLoader)
    except (yaml.YAMLError, Invalid, TypeError, ValueError):
        return text
    if not isinstance(data, dict) or data.get("status") != "retired":
        return text
    value = data.get("replaced-by")
    pin = _REPLACEMENT_PIN.fullmatch(value) if isinstance(value, str) else None
    if pin is None or not isinstance(node, yaml.MappingNode):
        return text
    fields = {}
    for key, scalar in node.value:
        if not isinstance(key, yaml.ScalarNode) or key.value in fields or key.value == "<<":
            return text
        fields[key.value] = (key, scalar)
    pair = fields.get("replaced-by")
    if pair is None:
        return text
    key, scalar = pair
    if (
        not isinstance(scalar, yaml.ScalarNode)
        or scalar.tag != "tag:yaml.org,2002:str"
        or scalar.style not in {None, "'", '"'}
        or scalar.start_mark.index < key.end_mark.index
    ):
        return text
    start, end = scalar.start_mark.index, scalar.end_mark.index
    raw = text[start:end]
    release = pin.group("release")
    if raw.count(release) != 1:
        return text
    # Only the release inside this exact scalar is data. Comments, other fields,
    # code fences and ordinary prose retain their existing identity checks.
    return text[:start] + raw.replace(release, "<release>", 1) + text[end:]


def style_check(root: Path, paths: list[str], settings: dict | None) -> dict:
    """Finite opt-in mechanical coverage; exemptions retain source roles, not active-file waivers."""
    if settings is None:
        return {"status": "not-selected"}
    if not isinstance(settings, dict) or not settings or set(settings) - _STYLE_ROLES:
        raise Invalid("Unsupported documentation style scope")
    documents = [p for p in paths if p and (p.endswith((".md", ".mdc", ".md.jinja")))]
    ownership: dict[str, str] = {}
    for role, patterns in settings.items():
        if (
            not isinstance(patterns, list)
            or not patterns
            or not all(isinstance(p, str) and p for p in patterns)
        ):
            raise Invalid(f"Documentation style {role} needs nonempty path patterns")
        for pattern in patterns:
            if Path(pattern).is_absolute() or ".." in Path(pattern).parts:
                raise Invalid("Documentation style paths must stay inside the repository")
            parts = set(Path(pattern).parts)
            if role == "historical" and not parts.intersection({"archive", "history", "snapshots"}):
                raise Invalid("Historical exclusions need an explicit historical source directory")
            if role == "literal" and not parts.intersection({"fixtures", "third_party", "vendor"}):
                raise Invalid("Literal exclusions need a fixture or third-party source directory")
            if role == "legal" and not Path(pattern).name.upper().startswith(
                ("LICENSE", "COPYING", "NOTICE")
            ):
                raise Invalid("Legal exclusions may select only legal-source filenames")
            matched = [p for p in documents if _selected(p, pattern)]
            if not matched:
                raise Invalid(f"Documentation style selector matched no Markdown: {role} {pattern}")
            for path in matched:
                if path in ownership and ownership[path] != role:
                    raise Invalid(f"Documentation has conflicting source roles: {path}")
                ownership[path] = role
    missing = sorted(set(documents) - ownership.keys())
    if missing:
        raise Invalid(f"Documentation style scope leaves Markdown unclassified: {missing[0]}")
    checked = 0
    findings = []
    parser = MarkdownIt("commonmark")
    for relative, role in sorted(ownership.items()):
        if role not in {"authored", "generated"}:
            continue
        path = contained(root, relative, exists=True)
        text = markdown_body(path.read_text(encoding="utf-8"))
        checked += 1
        for token in parser.parse(text):
            if token.type not in {"inline", "html_block", "fence", "code_block"}:
                continue
            if token.type == "inline":
                html = _AuthoredText()
                html.feed(parser.renderer.render([token], parser.options, {}))
                identity_text = " ".join(html.text)
            elif token.type == "html_block":
                html = _AuthoredText()
                html.feed(token.content)
                identity_text = " ".join(html.text)
            else:
                identity_text = token.content
                if token.type == "fence" and token.info.strip() == "item":
                    identity_text = _retirement_data_text(identity_text)
            raw = _URL.sub("", identity_text)
            line = token.map[0] + 1 if token.map else 1
            for name, pattern in (
                ("release-value", _RELEASE_VALUE),
                ("fingerprint", _FINGERPRINT),
                ("transient-claim", _FRESHNESS),
            ):
                if pattern.search(raw):
                    findings.append(f"{relative}:{line}: {name}")
            if token.type not in {"inline", "html_block"}:
                continue
            # Code operators and literal code retain their syntax; copied identity above covers all text.
            prose = " ".join(t.content for t in token.children or [] if t.type in {"text", "html_inline"})
            if token.type == "html_block":
                prose = token.content
            if "\u2014" in prose or _EMOJI.search(prose):
                line = token.map[0] + 1 if token.map else 1
                findings.append(f"{relative}:{line}: decorative-prose")
    if not checked:
        raise Invalid("Documentation style matched no active authored or generated Markdown")
    if findings:
        # Source text can be private. Report only paths, positions and mechanical categories.
        raise Invalid("Documentation style findings:\n" + "\n".join(findings))
    return {
        "status": "success",
        "files": checked,
        "preserved": len(ownership) - checked,
        "coverage": ["release-values", "fingerprints", "transient-claims", "em-dashes", "emoji"],
        "limits": "Mechanical selected text checks do not establish factual or semantic correctness",
    }


class _HtmlReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.targets: list[str] = []
        self.anchors: set[str] = set()

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if value and key in {"href", "src"}:
                self.targets.append(value)
            if value and (key == "id" or (tag == "a" and key == "name")):
                self.anchors.add(value)


def markdown_targets(text: str) -> list[str]:
    html = _HtmlReferences()
    targets = []
    for token in MarkdownIt("commonmark").parse(text):
        if token.type == "html_block":
            html.feed(token.content)
        for child in token.children or []:
            if child.type in {"link_open", "image"}:
                value = child.attrGet("href" if child.type == "link_open" else "src")
                if value:
                    targets.append(value)
            elif child.type == "html_inline":
                html.feed(child.content)
    return targets + html.targets


def markdown_anchors(text: str) -> set[str]:
    html = _HtmlReferences()
    anchors: set[str] = set()
    counts: dict[str, int] = {}
    tokens = MarkdownIt("commonmark").parse(text)
    for index, token in enumerate(tokens):
        if token.type == "heading_open":
            heading = tokens[index + 1]
            title = "".join(t.content for t in heading.children or [] if t.type in {"text", "code_inline"})
            slug = re.sub(r"[^\w\- ]", "", title.lower()).replace(" ", "-")
            count = counts.get(slug, 0)
            anchors.add(slug + (f"-{count}" if count else ""))
            counts[slug] = count + 1
        if token.type == "html_block":
            html.feed(token.content)
        for child in token.children or []:
            if child.type == "html_inline":
                html.feed(child.content)
    return anchors | html.anchors


class _AuthoredText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.text: list[str] = []

    def handle_data(self, data):
        self.text.append(data)

    def handle_comment(self, data):
        self.text.append(data)

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if value and key not in {"href", "src"}:
                self.text.append(value)
