# Measured speed practices

Measure the current critical path before choosing an optimization. Retain the source revision,
runner class, cold/warm state, queue and step durations, selected input sizes and failed attempts.
Compare repeated observations under matching conditions. The practices below explain mechanisms;
a project establishes its own improvement and verification evidence.

Optimization retains the consumer's selected integration route, required checks, complete source
identity and actual delivery result. This guide changes no project policy, cache route, runner or
target configuration.

## Promotion and admission

Promote the exact eligible composition through the project's accepted route. Independent providers
can qualify independently before the composition advances. Record the real head, base, workflow,
attempt, aggregate and original artifact producer; successful feedback publication is separate.

Use ancestry-preserving fast-forward reconciliation where the selected branch contract permits it.
Equal trees alone do not prove retained ancestry or authorize replacing a promotion PR. Preserve
hotfixes, concurrent work and every legitimate task commit.

Diagnose a failed run before selecting a retry. Reconcile uncertain effects and the actual owning
contract, preserve the first failure and admit the replacement attempt independently. A green
unrelated job or an earlier attempt cannot replace the required current result.

## Checkout and history

Fetch the paths and objects the operation actually needs. The native checkout action supports
sparse checkout and partial-clone filters such as blob:none; measure their real transport cost.
Lazy object fetches still require the selected read authority. Keep ephemeral credentials within
their authorized operation and preserve the action's credential-retention policy.

A history scanner still needs its complete required history and referenced content. A missing
object, failed fetch or incomplete scan remains unresolved. Inspect persistent sparse settings
before another job reuses the workspace.

A verified local reference repository can reduce downloads. Its object ownership, retention and
availability remain explicit; use native dissociation when an independent checkout is required.
An optimization does not select a new public fallback or change a project's private registry policy.

## Native tools and shared inputs

Prepare the project's selected toolchain before its commands execute. Callee bootstrap tools and
project runtimes keep their own identities. Check the effective executable and interpreter after
actions that affect PATH; use supported step contexts for job-owned temporary preparation.

Where the selected official runner supports an action archive cache, retain exact owner/repository,
immutable action revision and verified archive bytes. A cache hit is byte transport, while native
source and producer checks still establish acceptance. Existing SDK, shared-cache and host owners
retain their scopes.

## Container builds and cache mounts

Include every semantically relevant Dockerfile, context, ignore rule, selected build argument,
platform and external image reference in the build's native input identity. Unknown dependencies
require a rebuild. Reuse an existing image only when the complete selected input and image identity
are unchanged and the project's artifact contract permits reuse.

Choose an export mode supported by the actual BuildKit backend. Layer export and mutable compiler
cache mounts have different retention behavior. Docker evaluates ordered garbage-collection
policies; an owning builder can assign measured age and capacity budgets to cache mounts and other
records while preserving disk margin. Read the effective policy back through the selected builder.
This source does not apply a builder policy or prune shared storage.

## Target work and readiness

An authorized delivery can avoid unchanged work when its current inputs, retained artifact and
target state are actually established. Preserve configuration provenance and original recovery
evidence. Log useful field names and digests while excluding secret values.

Use the target's real readiness and recovery criteria. Tune supported health-check scheduling only
while preserving those criteria; distinguish command success, container status, application readiness
and confirmed recovery. A resolver reload, restart, copied archive or elapsed delay is not itself
evidence that the consumer scenario works.

Atomic replacement of a bind-mounted file can leave a container using an earlier inode. Select and
qualify an appropriate native mount/update method for the actual application rather than treating
configuration bytes on disk as proof the process loaded them.

## Primary sources

- [GitHub checkout inputs and credential behavior](https://github.com/actions/checkout#usage)
- [Git clone reference and dissociation semantics](https://git-scm.com/docs/git-clone)
- [GitHub workflow context availability](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)
- [Official runner action archive preparation](https://github.com/actions/runner/blob/main/src/Runner.Worker/ActionManager.cs)
- [Docker cache storage backends](https://docs.docker.com/build/cache/backends/)
- [Docker build garbage collection](https://docs.docker.com/build/cache/garbage-collection/)
- [Compose health-check scheduling](https://docs.docker.com/reference/compose-file/services/#healthcheck)
