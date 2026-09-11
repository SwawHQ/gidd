# GIDD-managed tools

This fixed shared tool directory is ~/.agents/skills.tools/gidd/.
It is independent of the skill installation directory and serves all repositories.
Do not add SKILL.md, repository config.toml or Git metadata here.

- bun/, node/, gh/: verified programs, upstream licenses and install.json.
- git/: official Windows x64 MinGit, including cmd/git.exe and required libraries,
  helpers and licenses. Keep the tree intact. Git uses gidd.install/v2; other
  tools use v1. Git/gh records contain a unique installation_id for repair.
- js_exec.cmd: shared runtime launcher. Ordinary commands use it without
  compatibility probes. It does not bind a repository or change console encoding.
- tool-bindings.json: generated Git/gh absolute paths and last verified versions;
  managed entries include the install.json hash. Ordinary execution does not
  scan PATH or rehash payloads. Rerun tools --ensure when bindings/tools change.
- .runtime-path-<SHA256>: directory junctions to external Unicode runtime paths.
  Remove links themselves; never recurse into or delete their external targets.
- .cache/<tool>/: interrupted downloads/extraction, rebuilt on retry.
- .cache/install.lock/: shared Shell/JS lock with a unique owner marker.
  Never delete a live or uncertain owner's lock. Old nonempty unknown locks stay.
- .cache/previous-<tool>/: retained old installation awaiting publication/recovery.
  Runtime launcher publication commits runtime replacement. Git/gh binding
  publication commits their replacement, identified by the new manifest hash.
- .cache/retired-<tool>-<UUID>: already committed old copies awaiting cleanup.
  In-use files may remain. Close using processes before removing these leftovers.
- .cache/bindings-invalid-<UUID>.json: preserved damaged binding data.

Run gidd.cmd tools --ensure to prepare/repair tools and bindings. tools --check is
read only; tools --ensure --jsruntime=node selects Node. --force explicitly reinstalls the
selected managed runtime, Git and gh; requires --ensure. Normal ensure reuses qualifying tools.
All version policy is internal; repository settings contain only download sources
for Bun/Node/gh. Git downloads the official stable MinGit asset and verifies its
SHA-256. Other mirrored archives still use official checksum metadata.

Repair requires a readable ownership manifest without extra files or links.
Unknown directories/records are preserved. New copies are verified before old
ones are moved. Failed stages keep other completed tools; rerun tools --ensure.
Deleting shared storage requires explicit scope and no active installers/tools;
removing one repository must not remove it. External PATH tools are not owned.
File deletion does not revoke GitHub authentication. Upstream licenses remain.
