---
name: gidd
description: Prepare GIDD tools, diagnose prerequisites, configure repository GitHub settings, check identity, and request device authorization when explicitly asked to log in. Currently verified on Windows; repository enablement and Issue/PR workflows are not yet implemented.
license: MIT
---

# GIDD

Use the installed skill's gidd.cmd on Windows. When tool preparation is authorized, run `gidd.cmd bootstrap`; it now prepares a JS runtime, Git and gh and publishes shared execution bindings. Use `bootstrap --check` for read-only inspection. Old --yes and public setup commands are retired. Read [references/bootstrap.md](references/bootstrap.md) for version policy, two-stage execution, binding errors and recovery.

Bootstrap prefers managed Bun, managed Node, PATH Bun, then PATH Node. If no compatible runtime exists it downloads stable Bun; `bootstrap --node` selects/prepares Node LTS. One runtime suffices. `bootstrap --reinstall` explicitly reinstalls the selected managed runtime; --check cannot combine with --reinstall. Git/gh reuse qualifying installations or prepare stable versions. All version requirements are internal; config.toml must not specify any tool version fields. Source mirrors remain configurable for Bun/Node/gh; there are no tools.git fields.

Only bootstrap invokes native Shell. Shell prepares and publishes js_exec.cmd, then runs the JS preparation stage with the verified runtime. JS checks/prepares Git and gh and writes tool-bindings.json. Each stage reports its own result; partial failure preserves completed tools and does not claim overall readiness. Bootstrap does not initialize a repository, configure authors/remotes or log in.

Tools and generated bindings live permanently in ~/.agents/skills.tools/gidd/, shared by all repositories and independent of the skill installation scope. The location is not configurable. Ordinary commands start JS via js_exec.cmd and execute the bound Git/gh absolute paths without searching PATH, version probes or full payload hashing. The selected Git directory is prepended only to child-process PATH so gh uses the same Git. Binding/start errors prompt bootstrap; business failures keep their own reasons and never cause automatic fallback or retries. In-place external updates may only be detected by doctor/bootstrap --check. Rerun bootstrap after skill updates or tool changes. Changing shared bindings affects all repositories for this user.

An entry at <repository>/.agents/skills/gidd/ locates its repository using its own path and local .git marker, including worktrees, independently of cwd. Resolve the target from the user request before repository operations. User-level installations do not imply a target; ask only when it is unclear. Without an implicit target doctor reports tools and target_required; bootstrap can still prepare tools without a Git repository. Installation or successful bootstrap does not enable GIDD for a repository.

```powershell
& "<repository>\.agents\skills\gidd\gidd.cmd" bootstrap --check
& "<repository>\.agents\skills\gidd\gidd.cmd" bootstrap
& "<repository>\.agents\skills\gidd\gidd.cmd" doctor
& "<repository>\.agents\skills\gidd\gidd.cmd" identity
& "<repository>\.agents\skills\gidd\gidd.cmd" auth
```

Use help en / help zh; --help and -h are aliases, and no arguments show help. Help also requires js_exec.cmd. Language follows the argument, GIDD_LANG, then locale; unsupported system languages fall back to English. Bootstrap emits gidd.bootstrap/v1; ordinary argument errors use gidd.cli/v1. Commands preserve stdout/stderr and exit codes. Linux/macOS launchers are not implemented or verified.

Use [references/doctor.md](references/doctor.md) for offline, read-only diagnosis of tools, bindings, worktree, GitHub config and selected remote. Missing Git, missing bindings, non-Git directories, missing configuration and remote mismatch are distinct outcomes; none starts initialization. local_ready does not establish enablement, identity or push access.

Use config show / config set with [references/configuration.md](references/configuration.md). Runtime config is only <repository>/.agents/skills/gidd/config.toml; do not inherit user-level settings. Editable fields are github.hostname/account/remote and tools.node/bun/gh.source. Remove retired [bootstrap] and tool version fields while preserving unrelated comments and settings. First set creates the template; edits preserve comments, BOM and line endings. Editing does not install, authenticate or enable a repository.

When asked to check GitHub login, use identity and [references/identity.md](references/identity.md). It requires github.hostname/account/remote and performs read-only network checks with bound tools. Report API identity, Git remote readability and commit author separately; public remote readability does not prove push permission. It does not install, log in or switch accounts.

For explicit login requests use auth and [references/authorization.md](references/authorization.md). It requires github.hostname/account and a gh binding validated by bootstrap. Reuse a matching login; report another account without switching. Display this attempt's URL and one-time code, keep the waiting process and let the user authorize on any device. Verify actual API identity before success. Do not open a browser automatically. gh manages credentials; editing config does not authorize account changes.

Read [references/setup.md](references/setup.md) for installation integrity, MinGit scope, locks and cleanup. Bootstrap repairs only installations with clear ownership; preserve unknown files. Damaged bindings are backed up before rebuilding. Downloaded tools, installation records, launchers and caches stay outside skill/source; the shared tree must not contain SKILL.md, config.toml or Git metadata. INSTALLATION.md explains ownership and cleanup.

When copying the skill, exclude config.toml and config.toml.* edit files; preserve target config and use config.example.toml for a new instance. For removal identify actual skill location, repository config and shared root. Removing one repository does not authorize deleting shared storage. Full removal must explicitly include it; other repositories may still use it. Never remove reused external tools or call deletion GitHub logout/revocation.

Windows bootstrap, bindings, diagnosis, configuration and identity/device authorization are implemented. Full skill installation/update, enablement records and Issue/PR business scripts remain unimplemented. Shared JS must use standard APIs supported and tested by Node and Bun.
