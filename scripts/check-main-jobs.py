"""Gate every selected main job and account explicitly for inapplicable native cells."""

import json
import os

jobs = json.loads(os.environ["NDDEV_EXPECTED_JOBS"])
assert set(jobs) == {
    "source",
    "impact-plan",
    "native",
    "contract-actions",
    "admission",
    "windows",
    "macos",
    "delivery",
    "advanced-native",
    "public-security",
    "online-refs",
    "native-quality",
    "native-benchmark",
    "native-assessment",
    "native-clusterfuzz",
}
required = {"source", "impact-plan", "online-refs"}
if os.environ["NDDEV_RUNTIME_SELECTED"] == "true":
    required.update({"contract-actions", "delivery", "public-security"})
    assert os.environ["NDDEV_PUBLIC_SECURITY_STATUS"] == "success"
if os.environ["NDDEV_WINDOWS_SELECTED"] == "true":
    required.update({"admission", "windows"})
if os.environ["NDDEV_APPLE_SELECTED"] == "true":
    required.update({"admission", "macos"})
if os.environ["NDDEV_ADVANCED_SELECTED"] == "true":
    required.add("advanced-native")
if os.environ["NDDEV_NATIVE_SELECTED"] == "true":
    required.add("native")
for flag, name in (
    ("QUALITY", "quality"),
    ("BENCHMARK", "benchmark"),
    ("ASSESSMENT", "assessment"),
    ("CLUSTERFUZZ", "clusterfuzz"),
):
    if os.environ["NDDEV_" + flag + "_SELECTED"] == "true":
        required.add("native-" + name)
for name, job in jobs.items():
    expected = "success" if name in required else "skipped"
    assert job["result"] == expected, (name, job["result"], expected)
print("Every affected obligation completed; unselected native cells remain explicit")
