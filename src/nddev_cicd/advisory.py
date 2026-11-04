"""Compare advisory packages with one actual production image inventory; no delivery authority."""

from __future__ import annotations

import re

from .model import Invalid


def rows(report: dict, image: str) -> list[dict]:
    if (
        not re.fullmatch(r"sha256:[a-f0-9]{64}", image)
        or not isinstance(report, dict)
        or report.get("SchemaVersion") != 2
        or report.get("ArtifactType") != "container_image"
        or not isinstance(report.get("Metadata"), dict)
        or report.get("Metadata", {}).get("ImageID") != image
        or not isinstance(report.get("Results"), list)
        or len(report["Results"]) > 2000
    ):
        raise Invalid(
            "Advisory comparison needs a native image report bound to the actual immutable image ID"
        )
    for row in report["Results"]:
        if (
            not isinstance(row, dict)
            or row.get("Class") not in ("os-pkgs", "lang-pkgs")
            or not isinstance(row.get("Type"), str)
            or not row["Type"]
            or not isinstance(row.get("Target"), str)
            or not row["Target"]
        ):
            raise Invalid("Advisory comparison requires complete native vulnerability-only result rows")
    return report["Results"]


def coordinate(row: dict, purl: object, version: object) -> tuple[str, ...]:
    if (
        not isinstance(purl, str)
        or not purl.startswith("pkg:")
        or len(purl) > 4096
        or not isinstance(version, str)
        or not version
        or len(version) > 1024
        or any(c in purl + version for c in "\r\n\0")
    ):
        raise Invalid("Native package coordinates and installed versions must be unambiguous")
    # OS targets include the mutable display/reference name. PURLs retain the exact OS/distro/arch.
    # Language targets identify the actual binary/manifest path within this one component.
    return row["Class"], row["Type"], row["Target"] if row["Class"] == "lang-pkgs" else "", purl, version


def compare(
    candidate: dict, production: dict, *, candidate_image: str, production_image: str, component: str
) -> dict:
    """Package inclusion evidence only: caller still verifies CI, current production, policy and target lock."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", component):
        raise Invalid(
            "Select one exact production component; repository-wide source locks are not a baseline"
        )
    inventory = set()
    for row in rows(production, production_image):
        packages = row.get("Packages")
        if not isinstance(packages, list) or len(packages) > 100000:
            raise Invalid("The production report must retain its actual complete native package inventory")
        for package in packages:
            if not isinstance(package, dict) or not isinstance(package.get("Identifier"), dict):
                raise Invalid("Production package identity is unavailable")
            inventory.add(coordinate(row, package["Identifier"].get("PURL"), package.get("Version")))
    preexisting, introduced = [], []
    for row in rows(candidate, candidate_image):
        findings = row.get("Vulnerabilities")
        if findings is None:
            findings = []
        if not isinstance(findings, list) or len(findings) > 10000:
            raise Invalid("Candidate advisory findings are malformed or exceed the finite comparison budget")
        for finding in findings:
            if (
                not isinstance(finding, dict)
                or not isinstance(finding.get("PkgIdentifier"), dict)
                or not isinstance(finding.get("VulnerabilityID"), str)
                or not finding["VulnerabilityID"]
                or len(finding["VulnerabilityID"]) > 512
            ):
                raise Invalid("A candidate advisory has no unambiguous native package/finding identity")
            purl, version = finding["PkgIdentifier"].get("PURL"), finding.get("InstalledVersion")
            key = coordinate(row, purl, version)
            item = {"advisory": finding["VulnerabilityID"], "purl": purl, "version": version}
            (preexisting if key in inventory else introduced).append(item)
    if not preexisting and not introduced:
        raise Invalid(
            "An advisory exception requires actual reported findings, not an empty failed-check report"
        )
    return {
        "disposition": "introduced-advisories" if introduced else "preexisting-packages-only",
        "component": component,
        "candidate_image": candidate_image,
        "production_image": production_image,
        "preexisting": preexisting,
        "introduced": introduced,
    }
