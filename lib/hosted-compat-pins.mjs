// Isolated hosted-only compatibility fallback pins for unmigrated public callers.
// Managed runners (runner.environment == 'self-hosted') are strictly forbidden from reading this
// module: they resolve toolchains, tools, images and actions from NDDEV_CI_REGISTRY_SNAPSHOT and
// their verified RUNNER_TOOL_CACHE.
//
// Open gap tracked for hosted callers:
//   1. Public callers should pass explicit caller-owned tool/image inputs (maintained by Renovate).
//   2. Per-platform binary SHA-256 digests are not yet carried inside technologies.toml.
import { ActionError } from "./release-asset.mjs";
import { managedRunner } from "./runner-profile.mjs";

export function assertHostedOnly(environment = process.env, { allowStandaloneLocal = false } = {}) {
  const kind = environment.RUNNER_ENVIRONMENT ?? "";
  const declared = environment.INPUT_MANAGED ?? environment.SDK_MANAGED ?? "";
  if (allowStandaloneLocal && !kind && !declared) return;
  if (managedRunner(kind, declared)) {
    throw new ActionError(
      "Managed runners cannot read hosted compatibility pins; supply NDDEV_CI_REGISTRY_SNAPSHOT or the managed tool cache.",
    );
  }
}

const hostedJust = Object.freeze({
  version: "1.59.0",
  repository: "casey/just",
  source: "https://github.com/casey/just/releases/tag/1.59.0",
  targets: Object.freeze({
    "darwin-arm64": Object.freeze({
      asset: 643129724,
      name: "just-1.59.0-aarch64-apple-darwin.tar.gz",
      sha256: "6574cea774ed4cae12e24b6aa11857de33e80dab4667cf628fd5840df96a2a9d",
      binary_sha256: "dd760b653ab24afb6e11bb4c2de423f75085d2eea751f8e1d51058074052ecdd",
      size: 2174952,
      binary_size: 5171888,
    }),
    "win32-arm64": Object.freeze({
      asset: 643132438,
      name: "just-1.59.0-aarch64-pc-windows-msvc.zip",
      sha256: "a72808bc8f8028c25aaae87cf26405d2bd85d2769a779380b344c69607216971",
      binary_sha256: "4f54ce81fc2c99094be22bf3a0e28aff106ab7d92ff286f3979bee54e3b03f48",
      size: 2098112,
      binary_size: 5016064,
    }),
    "linux-arm64": Object.freeze({
      asset: 642950086,
      name: "just-1.59.0-aarch64-unknown-linux-musl.tar.gz",
      sha256: "23871b1702bfd550fb5f901778fd4290ecf2ee034a45a889fbe96d89b188086d",
      binary_sha256: "c6a42651abc5ea8518aa4054d7236267e4259e9543e5ae65051bbcc6aa462cff",
      size: 2343258,
      binary_size: 5729456,
    }),
    "darwin-x64": Object.freeze({
      asset: 643131819,
      name: "just-1.59.0-x86_64-apple-darwin.tar.gz",
      sha256: "036ead9df9bc31dbae9934ae3b4236ed124d0bafcffd33439460ae084d5c9cb7",
      binary_sha256: "800786f88539439a3ee3be97cfa2ef7b1a399adc6f4235f311f8e6a1afee4be4",
      size: 2357655,
      binary_size: 5727912,
    }),
    "win32-x64": Object.freeze({
      asset: 643131303,
      name: "just-1.59.0-x86_64-pc-windows-msvc.zip",
      sha256: "9c5463e2d0974e31bee71346aa5cbf19167de1585a4abc1bae7b3b04604ea9c0",
      binary_sha256: "146c26ccfe1e40fadb59183cf8bc17d46c0cdf1bd1e43e52cca686cef0c44627",
      size: 2292448,
      binary_size: 5922304,
    }),
    "linux-x64": Object.freeze({
      asset: 642949555,
      name: "just-1.59.0-x86_64-unknown-linux-musl.tar.gz",
      sha256: "409044617b6f06517c1035e55ca38c8c856ff8b650e41bc2aa1ef82d5903a23e",
      binary_sha256: "50cd9b4a47c26a2570a0cca1bf86a106290b1cd35b131630696f63b9fbd1400d",
      size: 2572537,
      binary_size: 6500496,
    }),
  }),
});

const hostedOsvScanner = Object.freeze({
  x64: Object.freeze({
    version: "2.7.1",
    repository: "google/osv-scanner",
    tag: "v2.7.1",
    name: "osv-scanner_linux_amd64",
    asset: 726165286,
    size: 58187936,
    sha256: "fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8",
  }),
  arm64: Object.freeze({
    version: "2.7.1",
    repository: "google/osv-scanner",
    tag: "v2.7.1",
    name: "osv-scanner_linux_arm64",
    asset: 726165576,
    size: 54198432,
    sha256: "983d22fbad9724514e3fcc6acc83b5fa64c5ffa6b0d9f510028f22c1b223ff81",
  }),
});

const hostedMergeStopTools = Object.freeze({
  jscpd: Object.freeze({
    version: "5.4.3",
    sha256: Object.freeze({
      x64: "291452d6005e3fa17b531552bf76f87ff85bc4ae31533e0c17a7997f84079868",
      arm64: "f363875348817f8e999ca090266b1265ba29322d6b5d1f6280aa0d136ab1ca9e",
    }),
  }),
  betterleaks: Object.freeze({
    version: "1.10.1",
    sha256: Object.freeze({
      x64: "c174b42d7aa60caf58c0c3e555c0e4bed01fe6b0d99a412bce777b5af4ce913e",
      arm64: "62a63199f9f61a6b5e5a6f58f048493db20fbc8c770014f4d903a4d97886e1bf",
    }),
  }),
  poutine: Object.freeze({
    version: "1.1.6",
    sha256: Object.freeze({
      x64: "abde716599a65608b023a69ed9316e5f083a7bca48612151c2720835883757ea",
      arm64: "460c90300c6329106b551c150682d12e457365f6436a6cbbd08fe79eb9a98131",
    }),
  }),
  actionlint: Object.freeze({
    version: "1.7.12",
    sha256: Object.freeze({
      x64: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
      arm64: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
    }),
  }),
  zizmor: Object.freeze({
    version: "1.32.0",
    sha256: Object.freeze({
      x64: "84a6acb975accc13408786a2bd274b572537ca19c933ebbc13e78f3988562071",
      arm64: "0cdd38fca6eb34ceb567548548d706332e3535ea66894b9168c048e03207b68c",
    }),
  }),
  committed: Object.freeze({
    version: "1.1.12",
    sha256: Object.freeze({
      x64: "9a860b0a557bc842df663ce923213ff36f077ae2783f8db3123738823279387f",
      arm64: "2077f9fa0157f3e0bfa7273327aa26c793d05b16620e046e499a982dd6fd2e7c",
    }),
  }),
  shellcheck: Object.freeze({
    version: "0.11.0",
    sha256: Object.freeze({
      x64: "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
      arm64: "68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc",
    }),
  }),
});

const hostedSecurityTools = Object.freeze({
  trufflehog: Object.freeze({
    version: "3.100.0",
    sha256: Object.freeze({
      x64: "b2d85eba59865e98f45c9fc9f77d2c6d62df529fdd5755af121304ea5a7cecbb",
      arm64: "aa61657049229ae523e8455fcbba87dff57b0a2ba6bdb391a38cf75e6d4016dd",
    }),
  }),
  kingfisher: Object.freeze({
    version: "2.19.1",
    sha256: Object.freeze({
      x64: "3449ba41007df91e6774a816dd64cc9385900a304ef3cbb58ab61e0a83448e1c",
      arm64: "273744b70304704e46fb980cbe37fc9a94a96f62d65aaf07af1f21ea94b4b09f",
    }),
  }),
  "osv-scanner": Object.freeze({
    version: "2.7.1",
    sha256: Object.freeze({
      x64: "fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8",
      arm64: "983d22fbad9724514e3fcc6acc83b5fa64c5ffa6b0d9f510028f22c1b223ff81",
    }),
  }),
  syft: Object.freeze({
    version: "1.57.2",
    assetX64: 756262255,
    sizeX64: 31486443,
    sha256: Object.freeze({
      x64: "ad92bd3ec1b94a3df01d4d0aec199afa9c42b72e86da436ff5f837914d32706b",
      arm64: "8efe605309c98798e1ee0cffdcf8c05ca26819b4cd44c0b03650f1e963e9bdb6",
    }),
  }),
  grype: Object.freeze({
    version: "0.122.1",
    assetX64: 763662038,
    sizeX64: 32723797,
    sha256: Object.freeze({
      x64: "f1ba7e2917ee1395618de20a98da0aa7c0fb1788927797651047c50502a37538",
      arm64: "819e5be3d9516432fedb7b6b56df7306c3a16607606dfc05826eefbb00e471da",
    }),
  }),
  trivy: Object.freeze({
    version: "0.76.2",
    assetX64: 713401165,
    sizeX64: 52714130,
    sha256: Object.freeze({
      x64: "bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf",
      arm64: "ab9d51f86e6a5fb936f605faff6b593ac51bc378fff4d3e8b9d58358b9c367c3",
    }),
  }),
});

const hostedImageBuilder = Object.freeze({
  buildxVersion: "v0.39.1",
  buildkitImage:
    "moby/buildkit:v0.35.1@sha256:baf6138eb8c37644800c7c913fba051e840ebb9ba13eaf92d92ef9a1712d0b4c",
});

export function hostedJustPin(environment = process.env) {
  assertHostedOnly(environment);
  return hostedJust;
}

export function hostedOsvScannerPins(environment = process.env) {
  assertHostedOnly(environment, { allowStandaloneLocal: true });
  return hostedOsvScanner;
}

export function hostedMergeStopPins(environment = process.env) {
  assertHostedOnly(environment);
  return hostedMergeStopTools;
}

export function hostedSecurityToolPins(environment = process.env) {
  assertHostedOnly(environment, { allowStandaloneLocal: true });
  return hostedSecurityTools;
}

export function hostedImageBuilderPin(environment = process.env) {
  assertHostedOnly(environment);
  return hostedImageBuilder;
}

export function hostedBetterleaksVersion(environment = process.env) {
  assertHostedOnly(environment, { allowStandaloneLocal: true });
  return hostedMergeStopTools.betterleaks.version;
}
