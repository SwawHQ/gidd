# GIDD-managed tools

This fixed tool storage location is ~/.agents/skills.tools/gidd/.
It is shared by repositories and independent of the skill installation directory.
It is not a skill: do not add SKILL.md or repository config.toml here.

- bun/, node/ and gh/: verified executables, upstream licenses and install.json.
- Repository config.toml selects versions and archive sources. Official metadata
  supplies checksums even when an archive mirror is selected. Floating versions
  resolve only when downloading; existing qualifying tools are reused.
- Node contains its runtime and LICENSE, without npm.
- install.json records the source, version and file hashes; do not edit it.
- .cache/<tool>/: interrupted downloads/extraction, rebuilt on the next retry.
- .cache/install.lock/: an atomically published directory with a unique owner
  marker. Both native stage0 and JavaScript honor it. Live or uncertain owners
  block installation; confirmed dead owners are reclaimed. PID reuse may require
  waiting for that process to exit. Never delete a live lock or its marker.
- Older versions used an OS-locked empty file at that same lock path. It is
  retired only when unlocked; older installers cannot enter a directory lock.
  Orphan .cache/lock-<UUID> staging directories are inert preparation remnants.

After interruption, retry gidd.cmd setup (optionally bun, node or gh). Completed
installations are checked before reuse. Unknown, corrupt or conflicting occupied
tool directories are preserved and require explicit review, never replacement.

Uninstalling one repository does not remove these shared tools. Delete this whole
directory only when explicitly removing shared storage and no installer is running.
Check other repositories first; reference tracking is not implemented. External
PATH tools are not owned here. Deleting files does not revoke GitHub authorization.
GIDD's MIT license does not replace upstream tool licenses.
