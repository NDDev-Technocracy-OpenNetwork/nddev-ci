import {createHash, randomUUID} from "node:crypto";
import {spawn, spawnSync} from "node:child_process";
import {chmodSync, createReadStream, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, linkSync, unlinkSync, writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {isDeepStrictEqual} from "node:util";

const entry = fileURLToPath(import.meta.url);
const label = "org.nddev.ci.image-owner";
const containerLabel = "org.nddev.ci.container-owner";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maxMetadata = 8 * 1024 * 1024;
let activeBuild;
const refuse = (message) => { throw new Error(message); };
const sha = (data) => "sha256:" + createHash("sha256").update(data).digest("hex");
const canonical = (value) => JSON.stringify(value, null, 2) + "\n";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function present(file) {
  try { lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) refuse("Unknown or malformed image fields.");
}
function relative(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_./-]+$/.test(value) || path.isAbsolute(value) ||
      value.split("/").some((part) => part === ".." || part === "") || value.length > 512)
    refuse("Image paths must stay inside the checkout.");
  return value;
}
function inside(root, value) {
  const result = path.resolve(root, relative(value));
  if (result !== root && !result.startsWith(root + path.sep)) refuse("Image path escapes its root.");
  const parts = path.relative(root, result).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (present(current) && lstatSync(current).isSymbolicLink()) refuse("Image paths cannot traverse symlinks.");
  }
  return result;
}
function readJson(file, strict = false) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxMetadata) refuse("Image metadata must be a bounded regular file.");
  const raw = readFileSync(file, "utf8");
  const value = JSON.parse(raw);
  if (strict && raw !== canonical(value)) refuse("Image JSON must use canonical formatting without duplicate fields.");
  return value;
}
function writeJson(file, value, exclusive = false) {
  writeFileSync(file, canonical(value), {mode: 0o600, flag: exclusive ? "wx" : "w"});
}
function run(program, args, optional = false) {
  const child = spawnSync(program, args, {encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 600000});
  if (child.error || child.status !== 0) {
    if (optional && !child.error && child.status === 1 && /No such (image|object)/i.test(child.stderr)) return null;
    refuse(program + " did not complete the declared image operation.");
  }
  return child.stdout;
}
async function hashFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024 ** 3) refuse("Image archive is not a bounded regular file.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return "sha256:" + hash.digest("hex");
}
function identity(env) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? "") ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
      !/^[A-Za-z0-9_-]+$/.test(env.GITHUB_JOB ?? "")) refuse("Image production requires exact source, run, attempt and job identity.");
  return {repository: env.GITHUB_REPOSITORY, source_commit: env.GITHUB_SHA,
    run_id: env.GITHUB_RUN_ID, run_attempt: env.GITHUB_RUN_ATTEMPT, job: env.GITHUB_JOB};
}
function state(env, create = false) {
  if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) refuse("Image state requires the job temporary directory.");
  const root = realpathSync(env.RUNNER_TEMP);
  const folder = inside(root, "nddev-ci");
  mkdirSync(folder, {recursive: true, mode: 0o700});
  const file = inside(folder, "image-producer.json");
  const binding = {...identity(env), workspace: realpathSync(env.GITHUB_WORKSPACE ?? process.cwd())};
  if (!present(file)) {
    if (!create) return null;
    writeJson(file, {...binding, owner: randomUUID()}, true);
  }
  const value = readJson(file, true);
  const {owner, ...actual} = value;
  if (!/^[a-f0-9-]{36}$/.test(owner ?? "") || !isDeepStrictEqual(actual, binding)) refuse("Image state belongs to another job.");
  return {...value, file};
}

export function admit(plan) {
  keys(plan, ["schema", "output", "images"]);
  if (plan.schema !== 1 || !Array.isArray(plan.images) || plan.images.length < 1 || plan.images.length > 32)
    refuse("An image plan needs one complete bounded image batch.");
  relative(plan.output);
  const names = new Set();
  for (const image of plan.images) {
    keys(image, ["name", "dockerfile", "context", "platform", "target", "public_build_args", "public_build_config_digest"]);
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(image.name ?? "") || names.has(image.name))
      refuse("Image names must be unique portable names.");
    names.add(image.name);
    relative(image.dockerfile); relative(image.context);
    if (!["linux/amd64", "linux/arm64"].includes(image.platform)) refuse("Declare exactly one supported Linux platform per image.");
    if (image.target !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(image.target)) refuse("Invalid image target.");
    if (!object(image.public_build_args) || Object.keys(image.public_build_args).length > 128 ||
        Object.entries(image.public_build_args).some(([key, value]) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(key) ||
          typeof value !== "string" || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)))
      refuse("Public build inputs must be bounded literal arguments.");
    if (image.public_build_config_digest !== undefined && !digestPattern.test(image.public_build_config_digest))
      refuse("Invalid public build configuration digest.");
  }
  return plan;
}

function inventory(archive) {
  const result = new Map();
  const lines = run("tar", ["--list", "--verbose", "--numeric-owner", "--full-time", "--quoting-style=literal", "--file", archive]).trim().split("\n");
  if (lines.length > 16384) refuse("Image archive has too many members.");
  for (const line of lines) {
    const match = /^([-d][rwx-]{9})\s+\S+\s+([0-9]+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (!match) refuse("Image archive contains a link, special member or unsupported metadata.");
    const name = match[3].replace(/^\.\//, "").replace(/\/$/, "");
    if (!/^(?:index\.json|oci-layout|manifest\.json|blobs(?:\/sha256(?:\/[a-f0-9]{64})?)?)$/.test(name) ||
        result.has(name) || !Number.isSafeInteger(Number(match[2]))) refuse("Image archive has unsafe or repeated members.");
    result.set(name, {path: match[3], size: Number(match[2]), directory: match[1][0] === "d"});
  }
  return result;
}
async function archiveData(archive) {
  const entries = inventory(archive);
  const verified = new Map();
  async function read(name, expected, json = true) {
    const member = entries.get(name);
    if (!member || member.directory || (expected && expected.size !== member.size)) refuse("Image descriptor has no exact regular member.");
    if (verified.has(name)) return verified.get(name);
    const child = spawn("tar", ["-xOf", archive, "--", member.path], {stdio: ["ignore", "pipe", "ignore"], timeout: 600000});
    const done = new Promise((resolve) => { child.on("error", () => resolve(-1)); child.on("close", resolve); });
    const hash = createHash("sha256"), chunks = [];
    let size = 0;
    try {
      for await (const chunk of child.stdout) {
        size += chunk.length;
        if (size > member.size || (json && size > maxMetadata)) refuse("Image member exceeds its bound.");
        hash.update(chunk);
        if (json) chunks.push(chunk);
      }
      if (await done !== 0 || size !== member.size) refuse("Image member did not stream completely.");
      const digest = "sha256:" + hash.digest("hex");
      if (expected && digest !== expected.digest) refuse("Image blob digest differs.");
      const value = {digest, size, ...(json ? {json: JSON.parse(Buffer.concat(chunks).toString("utf8"))} : {})};
      verified.set(name, value);
      return value;
    } finally { child.kill("SIGKILL"); await done; }
  }
  const blob = async (descriptor, json = true) => {
    if (!digestPattern.test(descriptor?.digest ?? "") || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1)
      refuse("Invalid image blob descriptor.");
    return read("blobs/sha256/" + descriptor.digest.slice(7), descriptor, json);
  };
  return {entries, verified, read, blob};
}

export async function inspectArchive(archive, image, expectedLabels, transport = false) {
  const data = await archiveData(archive);
  const {json: layout} = await data.read("oci-layout");
  const {json: wrapper} = await data.read("index.json");
  if (layout.imageLayoutVersion !== "1.0.0" || wrapper.manifests?.length !== 1) refuse("Expected one canonical OCI index.");
  const descriptor = wrapper.manifests[0];
  const {json: index} = await data.blob(descriptor);
  if (!Array.isArray(index.manifests) || index.manifests.length !== 2) refuse("Expected one platform and one attestation manifest.");
  const platform = index.manifests.find((row) => row.platform?.os + "/" + row.platform?.architecture === image.platform);
  const attestation = index.manifests.find((row) => row.annotations?.["vnd.docker.reference.type"] === "attestation-manifest");
  if (!platform || !attestation || attestation.annotations["vnd.docker.reference.digest"] !== platform.digest)
    refuse("Image attestations do not bind the declared platform.");
  const {json: manifest} = await data.blob(platform);
  const {json: config} = await data.blob(manifest.config);
  if (config.os + "/" + config.architecture !== image.platform ||
      Object.entries(expectedLabels).some(([key, value]) => config.config?.Labels?.[key] !== value))
    refuse("Image configuration differs from its build binding.");
  if (!Array.isArray(manifest.layers) || !Array.isArray(config.rootfs?.diff_ids) || manifest.layers.length !== config.rootfs.diff_ids.length)
    refuse("Image layers differ from the configuration.");
  for (const layer of manifest.layers) await data.blob(layer, false);
  const {json: attest} = await data.blob(attestation);
  await data.blob(attest.config);
  const predicates = new Set();
  for (const layer of attest.layers ?? []) {
    const {json: statement} = await data.blob(layer);
    if (!statement.subject?.some((subject) => subject.digest?.sha256 === platform.digest.slice(7)))
      refuse("Attestation subject differs from the image.");
    predicates.add(statement.predicateType);
  }
  if (![...predicates].some((type) => /^https:\/\/slsa\.dev\/provenance\//.test(type)) ||
      ![...predicates].some((type) => /^https:\/\/spdx\.dev\//.test(type))) refuse("Image provenance or SBOM is missing.");
  if (transport) {
    const {json: classic} = await data.read("manifest.json");
    if (classic.length !== 1 || classic[0].Config !== "blobs/sha256/" + manifest.config.digest.slice(7) ||
        !isDeepStrictEqual(classic[0].Layers, manifest.layers.map((layer) => "blobs/sha256/" + layer.digest.slice(7))) ||
        !isDeepStrictEqual(classic[0].RepoTags, [image.reference])) refuse("Native Docker save differs from the canonical image.");
  }
  if ([...data.entries].some(([name, member]) => !member.directory && !data.verified.has(name)))
    refuse("Image archive contains undeclared payload.");
  return {index: descriptor.digest, config: manifest.config.digest, diffIds: config.rootfs.diff_ids};
}

function inspectReference(reference) {
  const text = run("docker", ["image", "inspect", reference], true);
  if (text === null) return null;
  const rows = JSON.parse(text);
  if (rows.length !== 1) refuse("Ambiguous loaded image.");
  return rows[0];
}
function verifyLoaded(value, expected, owner) {
  if (value.Id !== expected.index || value.Descriptor?.digest !== expected.index ||
      value.Config?.Labels?.[label] !== owner || !isDeepStrictEqual(value.RootFS?.Layers, expected.diffIds))
    refuse("Loaded containerd index/config relationship differs.");
}
export function cleanup(env = process.env) {
  const owned = state(env);
  if (!owned) return;
  const filter = ["--filter", "label=" + label + "=" + owned.owner];
  const containers = run("docker", ["ps", "-aq", "--filter", "label=" + containerLabel + "=" + owned.owner]).trim().split("\n").filter(Boolean);
  for (const id of containers) {
    if (!/^[a-f0-9]{12,64}$/.test(id)) refuse("Invalid owned container identity.");
    const rows = JSON.parse(run("docker", ["container", "inspect", id]));
    if (rows.length !== 1 || rows[0].Config?.Labels?.[containerLabel] !== owned.owner) refuse("Refuse foreign container cleanup.");
    run("docker", ["container", "rm", "--force", id]);
  }
  const references = run("docker", ["image", "ls", ...filter, "--format", "{{.Repository}}:{{.Tag}}"]).trim().split("\n").filter(Boolean);
  const suffix = ":ci-" + owned.owner;
  for (const reference of new Set(references)) {
    if (!/^nddev-ci-local\/[a-z0-9][a-z0-9._-]{0,99}:ci-[a-f0-9-]{36}$/.test(reference) || !reference.endsWith(suffix)) continue;
    if (inspectReference(reference)?.Config?.Labels?.[label] !== owned.owner) refuse("Refuse foreign image cleanup.");
    run("docker", ["image", "rm", reference]);
  }
}

export function requireStore(info) {
  if (!Array.isArray(info) || !info.some((row) => Array.isArray(row) &&
      row[0] === "driver-type" && row[1] === "io.containerd.snapshotter.v1"))
    refuse("The declared Docker endpoint requires the containerd image store; repair its execution profile.");
}

export async function produce(plan, env = process.env) {
  admit(plan);
  requireStore(JSON.parse(run("docker", ["info", "--format", "{{json .DriverStatus}}"])));
  const owned = state(env);
  if (!owned) refuse("Run the prepared image producer entry before building.");
  const root = owned.workspace, output = inside(root, plan.output);
  if (run("git", ["-C", root, "rev-parse", "HEAD"]).trim() !== owned.source_commit) refuse("Image checkout differs from its workflow source.");
  const mirror = JSON.parse(env.NDDEV_CI_IMAGE_BUILD_ARGV ?? "[]");
  if (!Array.isArray(mirror) || mirror.some((arg) => typeof arg !== "string" || /[\x00-\x1f\x7f]/.test(arg)))
    refuse("Invalid prepared provider arguments.");
  let offset = 0;
  if (mirror[0] === "--network") {
    if (!isDeepStrictEqual(mirror.slice(0, 4), ["--network", "host", "--allow", "network.host"]))
      refuse("Invalid prepared network entitlement.");
    offset = 4;
  }
  for (let i = offset; i < mirror.length; i += 2) {
    if (mirror[i] !== "--build-arg" || !/^[A-Z_a-z][A-Za-z0-9_]*=[A-Za-z0-9.:/_,=+ -]*$/.test(mirror[i + 1] ?? ""))
      refuse("Only prepared provider build arguments are admitted.");
  }
  const specs = plan.images.map((image) => ({...image, reference: "nddev-ci-local/" + image.name + ":ci-" + owned.owner,
    dockerfile_digest: sha(readFileSync(inside(root, image.dockerfile)))}));
  const checkSource = (image) => {
    inside(root, image.context);
    run("git", ["-C", root, "diff", "--no-ext-diff", "--no-textconv", "--exit-code", "HEAD", "--", image.dockerfile, image.context]);
    if (sha(readFileSync(inside(root, image.dockerfile))) !== image.dockerfile_digest)
      refuse("Image Dockerfile changed during production.");
  };
  for (const image of specs) checkSource(image);
  const binding = sha(canonical({plan, specs, provider: mirror, source: identity(env)}));
  const imageLabels = (image) => ({[label]: owned.owner, "org.opencontainers.image.revision": owned.source_commit,
    "org.nddev.ci.image-input": sha(canonical({batch: binding, image}))});
  const names = specs.flatMap((image) => [image.name + ".oci.tar", image.name + ".load.tar"]).concat("images.json").sort();
  const replay = present(output);
  if (replay && (!lstatSync(output).isDirectory() || !isDeepStrictEqual(readdirSync(output).sort(), names)))
    refuse("Refuse partial, foreign or altered image output.");
  if (replay && names.some((name) => {
    const stat = lstatSync(path.join(output, name));
    return !stat.isFile() || (stat.mode & 0o7777) !== 0o644;
  })) refuse("Completed image output modes or member types differ.");
  if (!replay) {
    mkdirSync(path.dirname(output), {recursive: true});
    mkdirSync(output, {mode: 0o700});
  }
  const rows = [];
  try {
    for (const image of specs) {
      const labels = imageLabels(image);
      const archive = path.join(output, image.name + ".oci.tar"), saved = path.join(output, image.name + ".load.tar");
      if (!replay) {
        if (inspectReference(image.reference)) refuse("Refuse an existing image reference.");
        const args = ["buildx", "build", ...mirror, "--platform", image.platform, "--provenance=mode=max", "--sbom=true",
          "--output", "type=oci,dest=" + archive + ",compression=gzip,force-compression=true", "--file", inside(root, image.dockerfile),
          "--tag", image.reference, ...Object.entries(labels).flatMap(([key, value]) => ["--label", key + "=" + value]),
          ...Object.entries(image.public_build_args).sort().flatMap(([key, value]) => ["--build-arg", key + "=" + value]),
          ...(image.target ? ["--target", image.target] : []), inside(root, image.context)];
        console.log("Canonical image build: " + image.name);
        await new Promise((resolve, reject) => {
          const child = spawn("docker", args, {stdio: "inherit"});
          activeBuild = child;
          child.on("error", reject);
          child.on("close", (code) => {
            activeBuild = undefined;
            code === 0 ? resolve() : reject(new Error("Canonical image build failed."));
          });
        });
      }
      checkSource(image);
      const expected = await inspectArchive(archive, image, labels);
      if (!replay) {
        if (inspectReference(image.reference)) refuse("Refuse an image reference created during the build.");
        run("docker", ["load", "--input", archive]);
        verifyLoaded(inspectReference(image.reference), expected, owned.owner);
        run("docker", ["image", "save", "--output", saved, image.reference]);
      }
      const extra = await inspectArchive(saved, image, labels, true);
      if (!isDeepStrictEqual(expected, extra)) refuse("Native Docker save changes the canonical image identity.");
      rows.push({name: image.name, reference: image.reference, image_id: expected.config, oci_index_digest: expected.index,
        archive: path.basename(archive), archive_digest: await hashFile(archive),
        load_archive: path.basename(saved), load_archive_digest: await hashFile(saved),
        ...(image.public_build_config_digest ? {public_build_config_digest: image.public_build_config_digest} : {}),
        source_commit: owned.source_commit, run_id: owned.run_id, run_attempt: owned.run_attempt, build_input_digest: labels["org.nddev.ci.image-input"]});
    }
    const receipt = {schema: 1, images: rows};
    const manifest = path.join(output, "images.json");
    if (replay) {
      if (!isDeepStrictEqual(readJson(manifest, true), receipt)) refuse("Completed image output differs from its exact build binding.");
      for (let i = 0; i < specs.length; i++) {
        const image = specs[i], row = rows[i], labels = imageLabels(image);
        if (!inspectReference(image.reference)) run("docker", ["load", "--input", path.join(output, row.archive)]);
        const expected = await inspectArchive(path.join(output, row.archive), image, labels);
        verifyLoaded(inspectReference(image.reference), expected, owned.owner);
      }
    } else {
      if (!isDeepStrictEqual(readdirSync(output).sort(), names.filter((name) => name !== "images.json")))
        refuse("Foreign output appeared during image production.");
      writeJson(manifest + ".pending", receipt, true);
      linkSync(manifest + ".pending", manifest);
      unlinkSync(manifest + ".pending");
      for (const name of names) chmodSync(path.join(output, name), 0o644);
    }
    return receipt;
  } catch (error) { cleanup(env); throw error; }
}

export function initialize(env = process.env) {
  const owned = state(env, true);
  const network = env.IMAGE_BUILD_NETWORK ?? "";
  if (network !== "" && network !== "host") refuse("Invalid prepared build network.");
  const args = network ? ["--network", "host", "--allow", "network.host"] : [];
  for (const line of (env.IMAGE_BUILD_ARGUMENTS ?? "").split("\n").filter(Boolean)) {
    if (!/^[A-Z_a-z][A-Za-z0-9_]*=[A-Za-z0-9.:/_,=+ -]*$/.test(line)) refuse("Invalid prepared build argument.");
    args.push("--build-arg", line);
  }
  if (/[\r\n\0]/.test(entry)) refuse("Invalid image entry path.");
  return "NDDEV_CI_IMAGES=" + entry + "\nNDDEV_CI_IMAGE_BUILD_ARGV=" + JSON.stringify(args) +
    "\nNDDEV_CI_IMAGE_OWNER=" + owned.owner + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) process.once(signal, () => {
    activeBuild?.kill("SIGTERM");
    try { cleanup(); } catch (error) { console.error(error.message); }
    process.exit(code);
  });
  try {
    const command = process.argv[2];
    if (command === "initialize") process.stdout.write(initialize());
    else if (command === "cleanup") cleanup();
    else if (command === "produce" && process.argv.length === 4) await produce(readJson(process.argv[3], true));
    else refuse("Usage: images.mjs initialize|cleanup|produce PLAN.json");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
