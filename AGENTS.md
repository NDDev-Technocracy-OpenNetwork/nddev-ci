# Agents

- The repository is public. It holds only workflows and their code. Hosts, keys and private
  settings reach it as inputs or from the runner machine, never from this repository.
- A project's justfile defines its checks; the library only decides which recipes run and prepares
  the tools and the network cache around them.
- Callers pin a released commit. A change that alters what callers get ships as a new commit, and
  its promotion to `main` publishes it as an immutable release that Dependabot brings to callers.
- Every pull request goes into `dev`, a fix a caller needs at once included. `main` only moves
  forward to a `dev` commit whose full check passed, so a pull request into
  `main` parts the two branches.

`just check` before every commit.
