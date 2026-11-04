set shell := ["bash", "--norc", "-euo", "pipefail", "-c"]
set positional-arguments
set default-list

setup:
    uv sync --locked

check:
    uv run --locked ruff check src tests
    uv run --locked ruff format --check src tests
    uv run --locked basedpyright
    uv run --locked python -m doctest docs/examples.md
    uv run --locked python -m nddev_cicd reference --check

fix:
    uv run --locked ruff check --fix src tests
    uv run --locked ruff format src tests

test *args:
    uv run --locked pytest "$@"

build:
    uv build

runtime-binding:
    uv run --locked python scripts/check-runtime-lock.py

verify: check runtime-binding test

just-check:
    {{ quote(just_executable()) }} --justfile {{ quote(justfile()) }} --fmt --check
