# GIDD-managed tools

This fixed tool storage location is ~/.agents/skills.tools/gidd/.
It is shared by repositories and independent of the skill installation directory.
It is not a skill: do not add SKILL.md or repository config.toml here.

- bun/, node/ and gh/: verified executables, upstream licenses and install.json.
- js_exec.cmd: bootstrap-generated shared runtime launcher; no repository binding.
  Normal commands execute it directly without runtime selection or compatibility checks.
  Rerun bootstrap after skill updates, runtime changes or a broken launcher.
  bootstrap --node --yes switches the launcher for every repository of this user.
- Repository config.toml selects archive sources and the gh version.
  Bun stable / Node LTS are internal download policies. Official metadata
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

For launcher/runtime recovery run gidd.cmd bootstrap (read only), then --yes
when preparation is authorized. --reinstall --yes replaces managed Bun; --node
selects Node. Verified new payloads precede replacement. .cache/previous-bun or
previous-node retain an old installation until launcher publication; the next
bootstrap --yes restores interrupted backups before rechecking. Unknown files
or malformed ownership records are preserved. JS setup never overwrites tools
or publishes a launcher. External tools are never replaced.
After publication, old backups are renamed .cache/retired-<name>-<UUID> before
cleanup. In-use leftovers may remain; cleanup_pending does not undo a published
launcher. Close using processes before removing those retired cache directories.

Uninstalling one repository does not remove these shared tools. Delete this whole
directory only when explicitly removing shared storage and no installer is running.
Check other repositories first; reference tracking is not implemented. External
PATH tools are not owned here. Deleting files does not revoke GitHub authorization.
GIDD's MIT license does not replace upstream tool licenses.
