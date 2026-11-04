"""Native mobile artifact inspection; signatures and store authority remain separate."""

from __future__ import annotations

import os
import plistlib
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from .model import Invalid, Unavailable


def android_manifest(path: Path) -> dict:
    if path.suffix == ".apk":
        tool = os.environ.get("NDDEV_APKANALYZER") or shutil.which("apkanalyzer")
        if not tool:
            sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
            candidates = sorted(Path(sdk).glob("cmdline-tools/*/bin/apkanalyzer")) if sdk else []
            tool = str(candidates[-1]) if candidates else None
        if not tool:
            raise Unavailable("APK validation requires the selected Android SDK apkanalyzer")
        command = [tool, "manifest", "print", str(path)]
        validator = "apkanalyzer"
    else:
        jar = os.environ.get("BUNDLETOOL_JAR")
        if not jar or not Path(jar).is_file() or not shutil.which("java"):
            raise Unavailable("AAB validation requires Java and a pinned existing BUNDLETOOL_JAR")
        validate = subprocess.run(
            ["java", "-jar", jar, "validate", "--bundle=" + str(path)],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if validate.returncode:
            raise Invalid("Native bundletool rejected AAB: " + validate.stderr[-500:])
        command = ["java", "-jar", jar, "dump", "manifest", "--bundle=" + str(path), "--module=base"]
        validator = "bundletool"
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=120)
        if result.returncode or not 0 < len(result.stdout) <= 16 * 1024 * 1024:
            raise Invalid("Native Android validator rejected the manifest: " + result.stderr[-500:])
        manifest = ET.fromstring(result.stdout)
    except (OSError, subprocess.TimeoutExpired, ET.ParseError) as error:
        raise Invalid("Native Android manifest validation failed") from error
    package = manifest.get("package")
    if manifest.tag != "manifest" or not package:
        raise Invalid("Native Android manifest has no application package identity")
    return {"validator": validator, "package": package}


def mobile_format(path: Path) -> dict:
    """Inspect native mobile packaging, separately from signing or store authorization."""
    if path.suffix == ".xcarchive" and path.is_dir():
        metadata = plistlib.loads((path / "Info.plist").read_bytes())
        if not metadata.get("ApplicationProperties") or not list(
            path.glob("Products/Applications/*.app/Info.plist")
        ):
            raise Invalid("XCArchive has no native application metadata")
        return {"format": "xcarchive", "signing": "not-verified"}
    if not path.is_file() or path.suffix not in {".apk", ".aab", ".ipa"}:
        raise Invalid("Select a native APK, AAB, IPA or contained XCArchive")
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if any(Path(name).is_absolute() or ".." in Path(name).parts for name in names):
                raise Invalid("Mobile package contains an escaping member")
            if path.suffix in {".apk", ".aab"}:
                name = "AndroidManifest.xml" if path.suffix == ".apk" else "base/manifest/AndroidManifest.xml"
                if not 0 < archive.getinfo(name).file_size <= 16 * 1024 * 1024:
                    raise Invalid("Android package has no bounded native manifest")
                archive.read(name)  # Validate the actual native manifest bytes and ZIP CRC.
            else:
                entries = [name for name in names if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", name)]
                if len(entries) != 1 or archive.getinfo(entries[0]).file_size > 1024 * 1024:
                    raise Invalid("IPA has no unique bounded native application metadata")
                metadata = plistlib.loads(archive.read(entries[0]))
                executable = metadata.get("CFBundleExecutable")
                if (
                    not metadata.get("CFBundleIdentifier")
                    or not isinstance(executable, str)
                    or "/" in executable
                ):
                    raise Invalid("IPA application identity/executable is unavailable")
                if archive.getinfo(str(Path(entries[0]).parent / executable)).file_size <= 0:
                    raise Invalid("IPA application executable is empty")
    except (zipfile.BadZipFile, KeyError, ValueError) as error:
        raise Invalid("Mobile file is not the declared native package") from error
    native = android_manifest(path) if path.suffix in {".apk", ".aab"} else {}
    return {"format": path.suffix.lstrip("."), "signing": "not-verified", **native}
