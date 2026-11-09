import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024});
  if (result.error || result.status !== 0)
    throw Error(`${command} did not complete the package metadata probe.`);
  return result.stdout;
}
run("sudo", ["apt-get", "update"]);
console.log(JSON.stringify({image_os: process.env.ImageOS, image_version: process.env.ImageVersion}));
for (const operation of ["policy", "madison"])
  console.log(run("apt-cache", [operation, "ffmpeg"]));
const fields = /^(Package|Version|Architecture|Depends|Filename|Size|SHA256):/;
console.log(run("apt-cache", ["show", "ffmpeg"]).split("\n").filter(line => fields.test(line)).join("\n"));
for (const command of ["ffmpeg", "ffprobe"]) {
  const result = spawnSync("which", [command], {encoding: "utf8", timeout: 1000});
  console.log(`${command}: ${result.status === 0 ? "present" : "absent"}`);
}
