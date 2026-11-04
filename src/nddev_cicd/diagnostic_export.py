"""Prepare only producer-owned diagnostics after native interpretation, before export."""

from __future__ import annotations

import contextlib
import contextvars
import json
import os
import re
from pathlib import Path
from xml.etree import ElementTree as ET

_files: contextvars.ContextVar[set[Path] | None] = contextvars.ContextVar("diagnostic_files", default=None)


def register(path: Path) -> None:
    files = _files.get()
    if files is not None:
        files.add(path.absolute())


def sensitive_values(environment: dict[str, str]) -> list[str]:
    return sorted(
        {
            value
            for key, value in environment.items()
            if re.search(r"TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY", key, re.IGNORECASE)
            and len(value) >= 4
        },
        key=lambda value: (-len(value), value),
    )


def redact(text: str, values: list[str]) -> str:
    for value in values:
        text = text.replace(value, "***")
    return text


def redact_data(value, values: list[str]):
    if isinstance(value, str):
        return redact(value, values)
    if isinstance(value, dict):
        return {redact_data(k, values): redact_data(v, values) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_data(item, values) for item in value]
    return value


def _sanitize(path: Path, values: list[str]) -> None:
    if not path.exists():
        return
    if path.is_symlink() or not path.is_file():
        raise ValueError("Owned diagnostic export requires regular files")
    text = path.read_text(encoding="utf-8", errors="replace")
    safe = redact(text, values)
    if path.suffix.lower() == ".json":
        try:
            document = json.loads(text)
        except ValueError:
            pass  # Preserve a failed native report's useful malformed text.
        else:
            safe = text
            cleaned = redact_data(document, values)
            if cleaned != document:
                safe = json.dumps(cleaned, indent=2, ensure_ascii=False) + "\n"
    elif path.suffix.lower() in {".xml", ".trx"}:
        # Portable target execution registers logs without selecting source XML export.
        from defusedxml.ElementTree import fromstring

        try:
            document = fromstring(text)
        except (ValueError, ET.ParseError):
            pass
        else:
            safe = text
            changed = False
            for node in document.iter():
                for field in ("text", "tail"):
                    original = getattr(node, field)
                    if original is not None:
                        cleaned = redact(original, values)
                        changed |= cleaned != original
                        setattr(node, field, cleaned)
                for key, original in list(node.attrib.items()):
                    cleaned = redact(original, values)
                    changed |= cleaned != original
                    node.set(key, cleaned)
            if changed:
                safe = ET.tostring(document, encoding="unicode")
    if safe != text:
        path.write_text(safe, encoding="utf-8")


@contextlib.contextmanager
def prepare(output: Path, environment: dict[str, str]):
    files: set[Path] = set()
    token = _files.set(files)
    values = sensitive_values({**os.environ, **environment})
    try:
        for name in ("result.json", "cache.json"):
            register(output / name)
        for name in ("gitleaks.log", "result.json"):
            register(output / "secret-scan" / name)
        yield values
    finally:
        try:
            for path in sorted(files):
                if not path.resolve().is_relative_to(output.resolve()):
                    if path.is_relative_to(output.absolute()):
                        raise ValueError("Owned diagnostic export path escapes its result directory")
                    continue  # Caller source/report originals are never export-owned.
                _sanitize(path, values)
            # The action checks this only after the native process finishes.
            # Interrupted or failed sanitization must not authorize directory upload.
            (output / ".diagnostics-ready").touch()
        finally:
            _files.reset(token)
