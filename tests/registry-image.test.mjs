import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main as checkDockerfileMain } from "../actions/image-builder/check-dockerfile.mjs";
import { resolveHostedImageBuilder } from "../actions/image-builder/resolve.mjs";
import {
  checkDockerfileImages,
  checkHostedRunnerImage,
  checkImageReference,
  loadRegistrySnapshot,
  parseImageReference,
  resolveImage,
} from "../lib/registry-resolve.mjs";

function writeSnapshot(dir, toml, commit = "c".repeat(40)) {
  const file = path.join(dir, "registry.json");
  writeFileSync(file, JSON.stringify({
    schema_version: 1,
    registry_commit: commit,
    technologies_toml: toml,
  }));
  return file;
}

const imageToml = `
[technologies.alpine]
kind = "image"
lines = [{ version = "3.24.4", role = "latest" }]

[technologies.debian]
kind = "image"
lines = [{ version = "13.8", role = "latest" }]

[technologies.distroless]
kind = "image"
lines = [{ version = "debian13", role = "latest" }]

[technologies.dockerfile-frontend]
kind = "image"
lines = [{ version = "1.29.0", role = "latest" }]

[technologies."actions/runner-images"]
kind = "image"
lines = [
  { version = "ubuntu-24.04", role = "compat" },
  { version = "ubuntu-24.04-arm", role = "compat" },
  { version = "macos-26", role = "compat" },
  { version = "windows-2025", role = "compat" },
]

[technologies.buildx]
kind = "toolchain"
lines = [{ version = "0.39.1", role = "latest" }]

[technologies.buildkit]
kind = "toolchain"
lines = [{ version = "0.35.1", role = "latest" }]

[technologies.bun]
kind = "toolchain"
lines = [{ version = "1.4.5", role = "latest" }]

[technologies.jdk]
kind = "toolchain"
lines = [{ version = "27.0.1.1", role = "latest" }, { version = "25.0.5.1", role = "compat" }]

[technologies.uv]
kind = "toolchain"
lines = [{ version = "0.13.10", role = "latest" }]

[technologies.dotnet]
kind = "toolchain"
lines = [{ version = "11.0.100", role = "latest" }]

[technologies.ruby]
kind = "toolchain"
lines = [{ version = "4.0.10", role = "latest" }]

[technologies.postgresql]
kind = "service"
lines = [{ version = "18.7", role = "latest" }]

[technologies.redis]
kind = "service"
lines = [{ version = "8.10.3", role = "latest" }]

[technologies.valkey]
kind = "service"
lines = [{ version = "9.2.0", role = "latest" }]

[technologies.nginx]
kind = "service"
lines = [{ version = "1.31.10", role = "latest" }]

[technologies.clickhouse]
kind = "service"
lines = [{ version = "26.10.2.103", role = "latest" }]

[technologies.sql-server]
kind = "service"
lines = [{ version = "2025-CU10", role = "latest" }]
`;

test("image kind resolves and checks OCI references, hosted runner images and Dockerfiles against snapshot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "reg-image-"));
  try {
    const snapPath = writeSnapshot(root, imageToml);
    const snapshot = loadRegistrySnapshot({ NDDEV_CI_REGISTRY_SNAPSHOT: snapPath });

    assert.equal(resolveImage(snapshot, "alpine").version, "3.24.4");
    assert.equal(resolveImage(snapshot, "distroless").version, "debian13");
    assert.equal(parseImageReference("alpine:3.24.4@sha256:" + "a".repeat(64)).tag, "3.24.4");

    assert.equal(checkImageReference(snapshot, "alpine:3.24.4").key, "alpine");
    assert.equal(checkImageReference(snapshot, "debian:13.8-slim").key, "debian");
    assert.equal(checkImageReference(snapshot, "gcr.io/distroless/static-debian13:nonroot").key, "distroless");
    assert.equal(checkImageReference(snapshot, "docker/dockerfile:1.29.0").key, "dockerfile-frontend");
    assert.equal(checkImageReference(snapshot, "moby/buildkit:v0.35.1@sha256:" + "b".repeat(64)).key, "buildkit");
    assert.equal(checkImageReference(snapshot, "oven/bun:1.4.5-alpine").key, "bun");
    assert.equal(checkImageReference(snapshot, "eclipse-temurin:25.0.5.1_2-jdk").key, "jdk");
    assert.equal(checkImageReference(snapshot, "ghcr.io/astral-sh/uv:0.13.10-debian-slim").key, "uv");
    assert.equal(checkImageReference(snapshot, "mcr.microsoft.com/dotnet/sdk:11.0.100-alpine").key, "dotnet");
    assert.equal(checkImageReference(snapshot, "docker.io/library/ruby:4.0.10-slim").key, "ruby");
    assert.equal(checkImageReference(snapshot, "postgres:18.7-alpine").key, "postgresql");
    assert.equal(checkImageReference(snapshot, "redis:8.10.3-alpine").key, "redis");
    assert.equal(checkImageReference(snapshot, "valkey/valkey:9.2.0-alpine").key, "valkey");
    assert.equal(checkImageReference(snapshot, "nginx:1.31.10-alpine").key, "nginx");
    assert.equal(checkImageReference(snapshot, "clickhouse/clickhouse-server:26.10.2.103").key, "clickhouse");
    assert.equal(checkImageReference(snapshot, "mcr.microsoft.com/mssql/server:2025-CU10-ubuntu-22.04").key, "sql-server");

    assert.throws(() => checkImageReference(snapshot, "alpine:latest"), /not latest/);
    assert.throws(() => checkImageReference(snapshot, "alpine:3.20.0"), /outside the snapshot/);
    assert.throws(() => checkImageReference(snapshot, "postgres:17.2-alpine"), /outside the snapshot/);
    assert.throws(() => checkImageReference(snapshot, "mcr.microsoft.com/dotnet/sdk:9.0.100"), /outside the snapshot/);
    assert.throws(() => checkImageReference(snapshot, "gcr.io/distroless/static-debian12:nonroot"), /outside the snapshot/);
    assert.throws(() => checkImageReference(snapshot, "unregistered/app:1.0.0"), /does not declare/);

    assert.equal(checkHostedRunnerImage(snapshot, "ubuntu-24.04").label, "ubuntu-24.04");
    assert.throws(() => checkHostedRunnerImage(snapshot, "ubuntu-20.04"), /outside the snapshot/);

    const goodDockerfile = [
      "# syntax=docker/dockerfile:1.29.0",
      "ARG ALPINE_TAG=3.24.4",
      "FROM alpine:${ALPINE_TAG} AS build",
      "FROM build AS check",
      "FROM scratch AS final",
      "FROM gcr.io/distroless/static-debian13:nonroot",
    ].join("\n");
    const good = checkDockerfileImages(snapshot, goodDockerfile);
    assert.equal(good.violations.length, 0);
    assert.equal(good.checked.length, 3);

    const badDockerfile = "FROM alpine:3.19.0\n";
    const bad = checkDockerfileImages(snapshot, badDockerfile);
    assert.equal(bad.violations.length, 1);
    assert.match(bad.violations[0].reason, /outside the snapshot/);

    writeFileSync(path.join(root, "Dockerfile"), goodDockerfile);
    const cliOk = checkDockerfileMain({
      GITHUB_WORKSPACE: root,
      INPUT_DOCKERFILE: "Dockerfile",
      NDDEV_CI_REGISTRY_SNAPSHOT: snapPath,
    });
    assert.equal(cliOk.checked.length, 3);

    writeFileSync(path.join(root, "Dockerfile.bad"), badDockerfile);
    assert.throws(() => checkDockerfileMain({
      GITHUB_WORKSPACE: root,
      INPUT_DOCKERFILE: "Dockerfile.bad",
      NDDEV_CI_REGISTRY_SNAPSHOT: snapPath,
    }), /outside the registry snapshot/);

    // Hosted image-builder resolver honors explicit inputs, validates against snapshot and refuses managed runners.
    const resolved = resolveHostedImageBuilder({
      RUNNER_ENVIRONMENT: "github-hosted",
      NDDEV_CI_REGISTRY_SNAPSHOT: snapPath,
      INPUT_BUILDX_VERSION: "v0.39.1",
      INPUT_BUILDKIT_IMAGE: "moby/buildkit:v0.35.1@sha256:" + "c".repeat(64),
    });
    assert.equal(resolved.buildxVersion, "v0.39.1");
    assert.throws(() => resolveHostedImageBuilder({
      RUNNER_ENVIRONMENT: "self-hosted",
      NDDEV_CI_REGISTRY_SNAPSHOT: snapPath,
    }), /Managed runners cannot read hosted compatibility pins/);
    assert.throws(() => resolveHostedImageBuilder({
      RUNNER_ENVIRONMENT: "github-hosted",
      NDDEV_CI_REGISTRY_SNAPSHOT: snapPath,
      INPUT_BUILDX_VERSION: "v0.30.0",
    }), /outside the snapshot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
