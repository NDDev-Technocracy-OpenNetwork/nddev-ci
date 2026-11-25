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
