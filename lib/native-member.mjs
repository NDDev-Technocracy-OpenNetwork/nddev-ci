import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  openSync,
  closeSync,
  readSync,
  writeSync,
  fstatSync,
  lstatSync,
} from "node:fs";
import { ActionError } from "./release-asset.mjs";

export function filename(value) {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9_+-])?$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  )
    throw new ActionError("Asset filenames must be portable basenames.");
}

export function members(asset) {
  if (asset.members === undefined) return [];
  if (
    !Array.isArray(asset.members) ||
    !asset.members.length ||
    asset.members.length > 64 ||
    asset.executable === true
  )
    throw new ActionError(
      "An archive needs bounded native members and cannot itself be executable.",
    );
  for (const member of asset.members) {
    if (
      !member ||
      typeof member.path !== "string" ||
      member.path.length > 512 ||
      !/^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(member.path) ||
      member.path.split("/").some((part) => part === "." || part === "..") ||
      !Number.isSafeInteger(member.size) ||
      member.size < 1 ||
      member.size > 256 * 1024 * 1024 ||
      !/^[0-9a-f]{64}$/.test(member.sha256) ||
      (member.executable !== undefined &&
        typeof member.executable !== "boolean")
    )
      throw new ActionError(
        "Archive members need exact bounded paths, sizes and digests.",
      );
    filename(member.file);
  }
  return asset.members;
}

export function matches(file, pin) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isFile())
    throw new ActionError("Asset destination is not a regular file.");
  if (metadata.size !== pin.size) return false;
  const input = openSync(file, "r");
  try {
    const opened = fstatSync(input);
    if (!opened.isFile() || opened.size !== pin.size) return false;
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let size = 0,
      count;
    while ((count = readSync(input, buffer, 0, buffer.length, null)) !== 0) {
      size += count;
      if (size > pin.size) return false;
      digest.update(buffer.subarray(0, count));
    }
    return size === pin.size && digest.digest("hex") === pin.sha256;
  } finally {
    closeSync(input);
  }
}

export async function extract(archive, member, target) {
  const child = spawn("tar", ["-xOf", archive, "--", member.path], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 120000,
    windowsHide: true,
  });
  const completion = new Promise((resolve) => {
    let failure;
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => resolve({ code, failure }));
  });
  let output;
  try {
    output = openSync(target, "wx", 0o600);
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > member.size)
        throw new ActionError("Archive member exceeds its declared size.");
      digest.update(chunk);
      let written = 0;
      while (written < chunk.length)
        written += writeSync(output, chunk, written, chunk.length - written);
    }
    const result = await completion;
    if (result.failure || result.code !== 0)
      throw new ActionError("Pinned archive member extraction failed.");
    if (size !== member.size || digest.digest("hex") !== member.sha256)
      throw new ActionError("Archive member differs from its pinned bytes.");
  } finally {
    child.kill("SIGKILL");
    await completion;
    if (output !== undefined) closeSync(output);
  }
}
