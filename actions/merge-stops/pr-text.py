"""Check a pull request's title and description against a configured terms file.

Titles and descriptions are compared with the avoided words and machine-text phrases in the
configured TOML file, and every difference is a warning that never stops a merge. The file is named
in NDDEV_CI_TERMS as a local path or URL; a runner without it says so and checks nothing. Words
inside `code`, "quotes", link targets, bare URLs, HTML comments or fenced blocks are mentions, not
uses. Pull requests authored by bots pass.
"""

import json
import os
import re
import sys
import tomllib
import urllib.request

INLINE_CODE = re.compile(r"`[^`]*`")
QUOTED = re.compile(r'"[^"]*"|“[^”]*”')
LINK_TARGET = re.compile(r"\]\([^)]*\)")
ADDRESS = re.compile(r"\b[a-z][a-z0-9+.-]*://\S+", re.IGNORECASE)
COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)


def avoided(terms):
    found = []
    for term, entry in terms.get("terms", {}).items():
        for phrase in entry.get("avoid", []):
            found.append((phrase, term))
    machine = terms.get("machine", {})
    for phrase in machine.get("words", []) + machine.get("phrases", []):
        found.append((phrase, None))
    return [(re.compile(r"(?i)\b" + re.escape(phrase) + r"\b"), term) for phrase, term in found]


def used(text):
    """The text's lines without what they only mention."""
    lines, fenced = [], False
    for line in COMMENT.sub("", text).split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
            continue
        if fenced:
            continue
        line = INLINE_CODE.sub("", line)
        line = QUOTED.sub("", line)
        line = LINK_TARGET.sub("]", line)
        lines.append(ADDRESS.sub("", line))
    return lines


def problems(patterns, where, text):
    for number, line in enumerate(used(text or ""), 1):
        for pattern, term in patterns:
            for match in pattern.finditer(line):
                word = match.group(0)
                if term:
                    yield f'{where}:{number}: write "{term}" instead of "{word}"'
                else:
                    yield f'{where}:{number}: "{word}" reads as machine text, see writing.md'


def main():
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as stream:
        request = json.load(stream)["pull_request"]
    author = request["user"]
    if author.get("type") == "Bot" or author.get("login", "").endswith("[bot]"):
        print(f"{author.get('login')} is a bot; its text passes.")
        return 0
    source = os.environ.get("NDDEV_CI_TERMS", "")
    if not source:
        print("::notice::this runner holds no registry/terms.toml (NDDEV_CI_TERMS); the text is not checked here")
        return 0
    if "://" not in source:
        with open(source, encoding="utf-8") as stream:
            terms = tomllib.loads(stream.read())
    else:
        with urllib.request.urlopen(source, timeout=30) as reply:
            terms = tomllib.loads(reply.read().decode("utf-8"))
    patterns = avoided(terms)
    found = list(problems(patterns, "title", request.get("title")))
    found += problems(patterns, "description", request.get("body"))
    for problem in found:
        print(f"::warning::{problem}")
    if found:
        print(f"{len(found)} word(s) of the pull request's text differ from {source}; edit the text, the merge is not stopped.")
        return 0
    print("The pull request's title and description use the configured terms.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
