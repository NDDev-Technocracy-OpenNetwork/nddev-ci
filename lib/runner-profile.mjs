import { ActionError } from "./release-asset.mjs";

export function managedRunner(kind, declared = "") {
  if (!["github-hosted", "self-hosted"].includes(kind) || !["", "true", "false"].includes(declared))
    throw new ActionError("A declared runner environment and boolean SDK ownership are required.");
  return declared === "" ? kind === "self-hosted" : declared === "true";
}

// The GitHub-hosted labels each entry point accepts: a public repository's runner, and the one a
// private job moves to with runner:github. `runs-on` cannot import this module, so
// tests/runner-labels.test.mjs holds every workflow's lists to it.
const linux = ["ubuntu-24.04", "ubuntu-24.04-arm", "ubuntu-26.04", "ubuntu-26.04-arm"];
export const hostedLabels = Object.freeze({
  linux: Object.freeze(linux),
  image: Object.freeze(["ubuntu-24.04", "ubuntu-24.04-arm"]),
  recipe: Object.freeze([...linux, "macos-15", "macos-26", "windows-2025", "windows-11-arm"]),
});

// Which list each entry point uses.
export const entryLabels = Object.freeze({
  "check.yml": "linux",
  "merge-stops.yml": "linux",
  "security.yml": "linux",
  "image.yml": "image",
  "recipe.yml": "recipe",
});
