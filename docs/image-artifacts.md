# Canonical image artifacts

An image job prepares the existing BuildKit provider with `images: true`.
The executor must use Docker's containerd image store; a classic image store
cannot retain the attestation index. No provider or storage reconfiguration
belongs to the producer. The producer uses the declared DOCKER_HOST unchanged;
a missing store fails with an execution-profile error, without selecting another
daemon or a classic-load fallback.

Write one complete plan using `JSON.stringify(plan, null, 2) + "\n"`:

```json
{
  "schema": 1,
  "output": "dist/images",
  "images": [
    {
      "name": "application",
      "dockerfile": "Dockerfile",
      "context": ".",
      "platform": "linux/amd64",
      "public_build_args": {}
    }
  ]
}
```

Run `node "$NDDEV_CI_IMAGES" produce PLAN.json`. The caller admits its own
public build arguments and can include their configuration digest as
`public_build_config_digest`. The producer accepts no shell fragments,
registry pushes or arbitrary Buildx flags. Prepared mirrors remain provider
inputs. Each image gets a unique job reference and exact source/run/attempt
and build-input labels.

One Buildx build exports the canonical OCI archive with SLSA provenance and
SPDX SBOM. That archive alone is loaded into containerd; native Docker save
creates the additional transport. Standard tar operations verify the bounded
archive metadata and every referenced blob. The loaded object ID is the OCI
index digest. The receipt's `image_id` is its image configuration digest;
`oci_index_digest` records the separate index identity.

The batch writes `images.json` only after every image and transport is
verified. It refuses existing partial/foreign output or altered source,
inputs, receipt, archive, or job ownership. Exact completed replay verifies
the retained bytes and reuses them without rebuilding. Tests and scanners
use the receipt's `reference`; they do not rebuild or load the additional
transport as a fallback. A release keeps the named artifact through the
existing immutable publisher.

Label test containers with `org.nddev.ci.container-owner=$NDDEV_CI_IMAGE_OWNER`.
The completion action always removes only that owner's containers and image
references, including after an upload failure or cancellation. It does not
prune useful layers, remove unrelated references or change deployment state.
Native qualification is `node --test tests/images-native.mjs` with an
already prepared BuildKit builder and containerd image store.
