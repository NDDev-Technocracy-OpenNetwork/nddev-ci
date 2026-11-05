# Agents

Follow the [agent standards](https://github.com/NDDev-Technocracy-Standarts/agent-standards),
starting with `vision.md`; delivery.md describes this library.

- The repository is public. It holds only workflows and their code. Hosts, keys and private
  settings reach it as inputs or from the runner machine, never from this repository.
- A project's justfile defines its checks; the library only decides which recipes run and prepares
  the tools and the network cache around them.
- Callers pin a commit. A change that alters what callers get ships as a new commit they move to.

`just check` before every commit.
