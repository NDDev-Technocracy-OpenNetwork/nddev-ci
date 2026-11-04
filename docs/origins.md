# Implementation origins

The [native source register](../spec/sources.yaml) retains exact original fixture references and paths.
Imported language fixtures keep their [original notice](../tests/native/NOTICE), copyright and grants.
The library's own source uses the [root license](../LICENSE); imported grants are not narrowed.
Fixture-specific native package license declarations remain authoritative.

Earlier CI and CD repositories informed the comparison. The shared runtime and composites are
implemented here; the earlier policy platform, paid capability tiers and approval state machine are
outside this library. Existing archive releases and consumers retain their own source contracts.

The JVM Maven wrapper keeps native distribution URLs and integrity fields in its wrapper properties,
with upstream script headers, LICENSE and NOTICE. The R fixture retains its generated activation
script and Posit grant. Android retains its wrapper JAR, external license and native distribution
integrity fields. Flutter scaffolding retains its [SDK notice](../tests/native/flutter/FLUTTER-LICENSE).
Rust and C++ fuzz harnesses retain their adjacent notices. External actions remain separately licensed
and pinned through native workflow fields.

Native tests execute selected fixture behavior rather than treating imported example presence as
successful coverage. Tool manifests own the fixture's chosen dependencies and audit feedback.
Canonical compilation belongs to the private standards-authoring path. Public installation, source
checks and consumer invocation use only this public library and selected native tools.
