import { ActionError } from "./release-asset.mjs";

export function managedRunner(kind, declared = "") {
  if (!["github-hosted", "self-hosted"].includes(kind) || !["", "true", "false"].includes(declared))
    throw new ActionError("A declared runner environment and boolean SDK ownership are required.");
  return declared === "" ? kind === "self-hosted" : declared === "true";
}
