---
name: gidd
description: Prepare GIDD tools and repository entry, diagnose prerequisites, configure repository GitHub settings, check identity, and request device authorization when explicitly asked to log in. Currently verified on Windows; repository enablement and Issue/PR workflows are not yet implemented.
license: MIT
---

# GIDD

Resolve the target repository from the user request. The skill can be installed inside or outside it, so the actual skill's preparation entry always requires an absolute Git working-tree root via --repo (--repository is also accepted). A suitable GitHub remote is required, but no commit or login. User-level installation alone does not select or enable a repository.

A repository installation at .agents/skills/gidd or .claude/skills/gidd can only prepare its own worktree, even when another clone or worktree shares the same remote. Shared installations outside Git trees can prepare other targets. A Git-contained installation with an unrecognized layout fails with installation_scope_unknown; do not treat a Git-managed skill collection or plugin source as a shared installation automatically. See the installation boundaries in [references/repository-entry.md](references/repository-entry.md).

```powershell
& "<skill-directory>\gidd.pre.ensure.cmd" help en
& "<skill-directory>\gidd.pre.ensure.cmd" --repo "<absolute-worktree-root>" --check
& "<skill-directory>\gidd.pre.ensure.cmd" --repo "<absolute-worktree-root>"
```

--check inspects tools, bindings, Git/GitHub remote and repository entry without downloads, recovery or writes. When preparation is authorized, omit --check to prepare shared tools and create <repository>/.agents/skills/gidd/gidd.link.cmd. Missing or stale entries require rerunning preparation. This does not create config, initialize Git, authenticate or enable GIDD; config init remains unimplemented. Read [references/repository-entry.md](references/repository-entry.md) for preconditions, output and relative/external locations.

Preparation retains a compatible bound runtime, then tries managed Bun, managed Node, PATH Bun and PATH Node. If none is compatible it downloads stable Bun. --jsruntime=bun|node selects a kind; Node downloads use LTS. --force reinstalls the selected managed runtime, Git and gh, preserving external tools, the other runtime and unknown files. Without a selector force retains the bound kind or defaults to Bun. Neither option can accompany --check. Read [references/bootstrap.md](references/bootstrap.md) for selection, bindings and recovery.

The native preparation entry verifies/prepares a runtime and publishes js_exec.cmd; JS then prepares Git, verifies the worktree/remote, prepares gh and publishes the repository entry. Failed stages preserve completed work without claiming overall readiness. Check diagnoses independent items when possible; missing runtime or Git marks dependent checks not_checked. The report remains gidd.tools/v1, with read_only identifying checks.

Tools and bindings live permanently in ~/.agents/skills.tools/gidd/, shared by all repositories and independent of skill installation. This path is not configurable. Ordinary commands start JS through js_exec.cmd and use bound Git/gh paths without searching PATH, version probes or full payload hashing. Only child-process PATH is adjusted so gh uses the same Git. Startup/binding errors direct users to gidd.pre.ensure; business errors do not trigger preparation or fallback retries. Shared binding changes affect all repositories for this user.

Use the generated repository entry from any working directory:

```powershell
& "<repository>\.agents\skills\gidd\gidd.link.cmd" help en
& "<repository>\.agents\skills\gidd\gidd.link.cmd" doctor --offline
& "<repository>\.agents\skills\gidd\gidd.link.cmd" doctor
& "<repository>\.agents\skills\gidd\gidd.link.cmd" auth
```

The link fixes its target and rejects overrides. A repository-installed gidd.cmd can also locate its own target from its path and .git marker, including worktrees. An unbound doctor reports target_required if no target is available. Ordinary gidd commands have no tools subcommand; preparation is only through gidd.pre.ensure.cmd.

Use help en / help zh; --help, -h and no arguments also show help. Ordinary help requires js_exec.cmd; preparation help works before a runtime or target is available. Language follows the argument, GIDD_LANG, then locale; unsupported system languages use English. Argument errors use gidd.cli/v1 for ordinary commands. Linux/macOS launchers are not implemented or verified.

Use [references/doctor.md](references/doctor.md) for read-only diagnosis. Doctor defaults to local checks plus GitHub API identity and eligible HTTPS remote reads; doctor --offline makes no network requests. It probes the running runtime and bound Git/gh only; gidd.pre.ensure with --repo and --check performs complete tool checks. Configuration, repository, binding and network errors remain distinct. local_ready is offline-only; checks_passed does not prove enablement or push access.

Use config show / config set with [references/configuration.md](references/configuration.md). Runtime config is only <repository>/.agents/skills/gidd/config.toml; do not inherit user-level settings. Editable fields are github.hostname/account/remote and tools.node/bun/gh.source. Remove retired [bootstrap] and tool version fields while preserving unrelated comments and settings. First set creates the template; edits preserve comments, BOM and line endings. Editing does not install, authenticate or enable a repository.

When asked to check GitHub login, use doctor. Read hostname/account/remote from repository config; never infer missing values. Report API identity, Git remote readability and commit author separately. SSH remote reads remain not_checked; network failure does not imply logged out. Doctor does not install, log in or switch accounts. The old identity command is removed without a compatibility alias; the doctor report remains gidd.doctor/v1.

For explicit login requests use auth and [references/authorization.md](references/authorization.md). It requires github.hostname/account and a gh binding validated by bootstrap. Reuse a matching login; report another account without switching. Display this attempt's URL and one-time code, keep the waiting process and let the user authorize on any device. Verify actual API identity before success. Do not open a browser automatically. gh manages credentials; editing config does not authorize account changes.

Read [references/setup.md](references/setup.md) for installation integrity, MinGit scope, locks and cleanup. Bootstrap repairs only installations with clear ownership; preserve unknown files. Damaged bindings are backed up before rebuilding. Downloaded tools, installation records, launchers and caches stay outside skill/source; the shared tree must not contain SKILL.md, config.toml or Git metadata. INSTALLATION.md explains ownership and cleanup.

When copying the skill, exclude config.toml, config.toml.* edit files, gidd.link.cmd and gidd.link.cmd.* generated files; preserve target config and use config.example.toml for a new instance. For removal identify actual skill location, repository config and shared root. Removing one repository does not authorize deleting shared storage. Full removal must explicitly include it; other repositories may still use it. Never remove reused external tools or call deletion GitHub logout/revocation.

Windows gidd.pre.ensure --repo <repository-path>, bindings, diagnosis, configuration and identity/device authorization are implemented. Full skill installation/update, enablement records and Issue/PR business scripts remain unimplemented. Shared JS must use standard APIs supported and tested by Node and Bun.
