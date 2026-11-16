// The public SDK-input contract. Versions belong to callers, not to this definition.
export const sdkInputs = {
  "rust-version": { depName: "rust", datasource: "rust-version" },
  "python-version": { depName: "python", datasource: "python-version" },
  "node-version": { depName: "node", datasource: "node-version", versioning: "node" },
  "bun-version": { depName: "bun", datasource: "npm", versioning: "npm" },
  "uv-version": { depName: "astral-sh/uv", datasource: "github-releases", versioning: "npm" },
  "java-version": { depName: "java-jdk", datasource: "java-version" },
  "go-version": { depName: "go", datasource: "golang-version" },
  "flutter-version": { depName: "flutter", datasource: "flutter-version" },
};

export const sdkDepType = "ci-sdk";
export const isSdkManager = (manager) => manager?.depTypeTemplate === sdkDepType;
const filePatterns = [
  "/(^|/)\\.github/(?:workflows|actions)/.+\\.ya?ml$/",
  "/(^|/)action\\.ya?ml$/",
];
const callers = {
  qualified: "/^NDDev-Technocracy-OpenNetwork\\/nddev-ci\\/.+@/i",
  relative: "/^(?:\\.|\\$)\\/(?:\\.github\\/workflows\\/[A-Za-z0-9_-]+\\.ya?ml|actions\\/[A-Za-z0-9_/-]+)$/",
};

export function sdkManager(mode) {
  if (!Object.hasOwn(callers, mode)) throw new Error("Unknown SDK caller mode");
  return {
    depTypeTemplate: sdkDepType,
    customType: "jsonata",
    managerFilePatterns: [...filePatterns],
    fileFormat: "yaml",
    matchStrings: [
      `($sdk := ${JSON.stringify(sdkInputs)}; **[$type(uses) = "string" and $exists($match(uses, ${callers[mode]}))].with.$each($, function($value, $key) {($spec := $lookup($sdk, $key); ($spec and $type($value) = "string" and $exists($match($value, /^[0-9]+\\.[0-9]+\\.[0-9]+([+.-][0-9A-Za-z.-]+)?$/))) ? $merge([$spec, {"currentValue": $value}]))}))`,
    ],
  };
}

export function sdkPreset() {
  return {
    $schema: "https://docs.renovatebot.com/renovate-schema.json",
    description: ["Literal SDK inputs in fully qualified calls to nddev-ci"],
    customManagers: [sdkManager("qualified")],
  };
}

export function selfConfiguration(current = {}) {
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error("Renovate configuration must be an object");
  }
  const managers = current.customManagers ?? [];
  if (!Array.isArray(managers)) throw new Error("customManagers must be an array");
  const owned = managers.filter(isSdkManager);
  if (owned.length > 1) throw new Error("Duplicate generated SDK manager");
  const generated = sdkManager("relative");
  return {
    ...current,
    customManagers: owned.length
      ? managers.map((manager) => isSdkManager(manager) ? generated : manager)
      : [...managers, generated],
  };
}
