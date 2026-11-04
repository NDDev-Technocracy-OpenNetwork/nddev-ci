# Native cache lifecycle

This implementation note explains the storage boundary behind R-0018. It does
not change an issued standard edition, select a private endpoint, or activate
another project's CI. The public library and GitHub-hosted workflows remain
usable without private infrastructure.

An operator can select a common native cache owner on its own hosts and private
runners. The selection needs an exact executable, configuration, protocol and
frontend binding. `NDDEV_CACHE_PROVIDER=nds` admits the digest-pinned alpha.5
protocol described in [usage](usage.md). Merely placing a tool on `PATH` does
not prove that every bootstrap, composite action or SDK uses it.

## Placement and compatibility

A shared filesystem cache and an HTTP download cache provide different reuse.
Native tools retain their package, ABI, compiler, lock, index, trust and locking
semantics. A download hit is established by the download service's receipt;
reusing a Cargo target is a separate observation. A successful build alone
establishes neither kind of hit.

Keep installed environments separate from disposable cache payloads. uv can
hardlink its packages when the cache and environment share a filesystem. Select
a distinct project environment rather than one mutable environment for every
project. Explicit caller environments retain their native ownership.
[uv cache documentation](https://docs.astral.sh/uv/concepts/cache/),
[project environment selection](https://docs.astral.sh/uv/concepts/projects/config/#project-environment-path).

Bun's native global store uses installed links that must survive collection.
Use native store pruning and preserve project configuration precedence; deleting
the whole store can break installed dependencies.
[Bun global store](https://bun.sh/docs/pm/global-store).

Do not share arbitrary writable stores across incompatible trust boundaries.
Untrusted public contributions must not write a trusted release cache. Some
native dependency stores require communicating processes for concurrent writes;
a shared read-only seed with independent writable stores can be appropriate for
isolated containers.
[GitHub cache access restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching),
[Gradle dependency cache](https://docs.gradle.org/current/userguide/dependency_caching.html).

## Completed use and collection

The declared idle interval begins after observed completed native use. Directory
mtime, calendar age, a wrapper returning, or an available descriptor alone do
not prove that all native consumers finished. Descendants can outlive the
foreground process. The owner must qualify its actual lifetime mechanism and
retain pending, interrupted, pinned, leased, future-time and unknown objects.

The library therefore defers whole-namespace deletion from its legacy local
cache. Its wrapper lock cannot establish the lifetime of detached native jobs.
Free-space pressure cannot turn this missing evidence into permission to
delete. A selected native owner performs collection under its own qualified
locks; another recursive deleter must not compete with it.

Choose the idle interval explicitly at the operator boundary. A one-day policy
is `86400` seconds; a public consumer may select another supported policy.
Native engine quotas and HTTP freshness are separate mechanisms. If an engine
cannot demonstrate a strict idle guarantee, report that limitation or defer its
collection. A broad Docker prune is not a substitute for the selected rule:
native BuildKit policies can collect under disk pressure as well as by age.
[BuildKit garbage collection](https://docs.docker.com/build/cache/garbage-collection/).

## Qualification and adoption

Each selected route needs actual cold, warm and offline exercises with unchanged
locks and SDK identities. Check effective paths and native reuse statistics,
installed links after GC, foreground and detached descendants, concurrent jobs,
interrupted ownership, and a second maintenance pass. A negative fixture must
still fail. Implementation unit tests remain separate from these observations.

Admission and maintenance deadlines must fit the bounded native operation.
Callers inspect both exit status and completion state; an incomplete scan is
not successful cleanup. Record completed, busy, unknown, errors, observed byte
changes and repeat results. A loaded timer or an advisory filesystem timestamp
does not establish any of them.

Adopt one consumer at a time. Preserve existing jobs and immutable old profiles;
retire old stores only after their own lifetime and ownership are established.
Unsupported package indexes, compiler-store lifetimes, OCI cache exports and
SDK-specific routes stay explicit gaps. A registry pull proxy does not prove a
BuildKit cache exporter, and one native fixture does not qualify an entire fleet.
[BuildKit registry cache](https://docs.docker.com/build/cache/backends/registry/).


## Rust setup and following-step path priority

With an admitted native cache provider, Rust setup preserves that owner's
frontend prefixes ahead of the exact SDK proxy directory in following GitHub
steps. It uses the existing native admission and does not select another owner.
The exact toolchain and native Cargo download selection keep their prior roles;
explicit caller target/build directories are not replaced.

GitHub accumulates file-command entries and prepends the later entries first.
The exporter therefore writes the admitted priority in reverse, preserving the
SDK as the fallback for compiler/proxy tools:
[runner file-command processing](https://github.com/actions/runner/blob/main/src/Runner.Worker/FileCommandManager.cs),
[runner path preparation](https://github.com/actions/runner/blob/main/src/Runner.Worker/Handlers/Handler.cs).
An unavailable provider or malformed path fails before exporting a partial SDK
fallback. Hosted/non-provider callers retain the original single SDK entry.
Unit lookup tests and real target/cache observations remain separate evidence.
