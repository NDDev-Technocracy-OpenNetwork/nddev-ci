"""Generate the native profile reference from the runtime's single capability table."""

from pathlib import Path

from .config import catalog
from .model import Invalid, atomic_json, digest


def generate(root: Path, *, check: bool = False) -> None:
    lines = [
        "# Native profile reference",
        "",
        "Generated from the executed runtime catalog; not a native-fixture verification claim.",
        "",
        "| Profile | Required native stages | Project commands required |",
        "|---|---|---|",
    ]
    for name, definition in catalog().items():
        optional = definition.get("optional_stages", [])
        required = [
            stage
            for stage, command in definition["stages"].items()
            if command is None and stage not in optional
        ]
        stages = [stage for stage in definition["stages"] if stage not in optional]
        lines.append(f"| `{name}` | {', '.join(stages)} | {', '.join(required) or 'Native defaults'} |")
    lines += [
        "",
        "Commands can be overridden through the caller contract. Catalog-listed waivable stages need an explicit non-applicability reason; selected tests and security remain required. Optional owned cleanup runs when declared.",
        "",
        "## Native defaults",
        "",
    ]
    lines += [
        "Native command arrays, manifests and report contracts live in the",
        "[runtime catalog](../src/nddev_cicd/profiles.json). The caller overrides only applicable",
        "stages through its native project contract; required stages remain required.",
        "",
    ]
    text = "\n".join(lines)
    path = root / "docs/profiles.md"
    if check:
        if not path.exists() or path.read_text() != text:
            raise Invalid("Native profile reference drift: run python -m nddev_cicd reference")
    else:
        path.parent.mkdir(exist_ok=True)
        path.write_text(text)
        atomic_json(
            root / "generated/profiles-outputs.json",
            {
                "generator": "native-profile-reference",
                "inputs": {"src/nddev_cicd/profiles.json": digest(Path(__file__).with_name("profiles.json"))},
                "outputs": {"docs/profiles.md": {"sha256": digest(path), "state": "current"}},
            },
        )
