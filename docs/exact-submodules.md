# Exact submodule checkout

Set `submodules: 'exact'` on a reusable check or recipe to enable exact
checkout of its direct Git submodules. Private origins use the caller's
existing scoped source credentials.

The prepare action reads the gitlinks in the checked-out commit and registers
the declared origins using Git. In a fresh workspace with Git's
`clone --revision` support it fetches each recorded revision directly at
depth one. It verifies each origin and SHA before recording the normal
submodule layout. Git versions without revision checkout and already populated
workspaces use the ordinary shallow submodule update.

A project can keep its existing setup recipe. Once prepare has fetched the
recorded revisions, an ordinary submodule update finds them in place. Source
admission and branch ancestry remain the responsibility of the project's
checks. The prepare log records which checkout path ran and its wall time.

A repository can declare a literal relative directory as `ciExclude` in a
submodule's `.gitmodules` section when its root CI has no use for those files.
The exact mode fetches that module with a blob filter and populates the rest
of the recorded tree. The omitted paths remain in the pinned Git tree.
The declaration applies to the fresh exact CI checkout; the normal
submodule command continues to work with existing clones.
