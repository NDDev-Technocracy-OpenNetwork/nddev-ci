# Native profile reference

Generated from the executed runtime catalog; not a native-fixture verification claim.

| Profile | Required native stages | Project commands required |
|---|---|---|
| `python` | setup, toolchain, format, lint, type, test, build, consumer | Native defaults |
| `rust` | toolchain, format, lint, test, doctest, build, policy | Native defaults |
| `go` | toolchain, format, lint, dependencies, test, build, package | Native defaults |
| `typescript-javascript` | setup, toolchain, format, lint, type, test, build, package | Native defaults |
| `c-cpp` | configure, format, lint, build, test, package | format, lint |
| `qt` | toolchain, configure, build, test, package | Native defaults |
| `dart-flutter` | setup, toolchain, format, lint, test, generate, build | generate, build |
| `jvm` | toolchain, dependencies, lint, test, build | dependencies, lint |
| `android-kotlin` | toolchain, dependencies, lint, test, build | Native defaults |
| `dotnet` | toolchain, setup, format, build, test, package | Native defaults |
| `swift` | toolchain, dependencies, lint, test, build, package | lint |
| `php` | toolchain, setup, locks, lint, type, test, package | Native defaults |
| `ruby` | toolchain, setup, lint, test, build | Native defaults |
| `r` | toolchain, setup, lint, test, build, package | package |
| `sql-data` | lint, empty-migration, previous-migration, test | empty-migration, previous-migration, test |
| `shell-powershell` | syntax, lint, test | syntax, lint, test |
| `documentation` | syntax, external-links, generate, examples | external-links, generate, examples |
| `workflows` | lint, security, contracts | Native defaults |
| `container` | lint, build, test, scan, sbom | build, test, scan, sbom |
| `infrastructure` | format, validate, security, generate | format, validate, security, generate |
| `security` | secrets, dependencies, sast, licenses | Native defaults |
| `architecture` | scope, dependencies | dependencies |
| `advanced-testing` | bounded-operation, result | bounded-operation, result |
| `web` | setup, toolchain, browser, format, html, css, test, build | Native defaults |

Commands can be overridden through the caller contract. Catalog-listed waivable stages need an explicit non-applicability reason; selected tests and security remain required. Optional owned cleanup runs when declared.

## Native defaults

Native command arrays, manifests and report contracts live in the
[runtime catalog](../src/nddev_cicd/profiles.json). The caller overrides only applicable
stages through its native project contract; required stages remain required.
