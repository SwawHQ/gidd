---
name: gidd
description: Diagnose GIDD prerequisites, configure repository GitHub settings, check identity, request device authorization when explicitly asked to log in, and prepare missing portable tools. Currently verified on Windows; repository enablement and Issue/PR workflows are not yet implemented.
license: MIT
---

# GIDD

Use the installed skill's gidd.cmd on Windows. Before first use, run `gidd.cmd bootstrap` for a read-only runtime/launcher check. When runtime preparation is authorized, run `gidd.cmd bootstrap --yes`; then run doctor. Read [references/bootstrap.md](references/bootstrap.md) for selection, compatibility, generated launchers and repair. Only explicit bootstrap invokes PowerShell. Ordinary commands use the shared js_exec.cmd to start JavaScript directly and never install their startup runtime.

Bootstrap prefers managed Bun, managed Node, PATH Bun, then PATH Node. Missing runtimes default to stable Bun; `bootstrap --node --yes` selects/prepares Node and updates the launcher shared by every repository for this user. Compatibility belongs to the standalone runtime-compat.mjs method, not repository settings or everyday command startup. Run bootstrap again after skill updates or runtime changes. Linux/macOS launchers are not implemented or verified.

The fixed shared root is ~/.agents/skills.tools/gidd/. It is not configurable and does not depend on the client or skill installation scope. bootstrap --yes may create it even when reusing PATH, to store js_exec.cmd and INSTALLATION.md. The launcher binds a runtime, never a repository. Missing launchers or broken bound runtimes require bootstrap; ordinary commands do not search for a fallback. Without --yes bootstrap does not generate a launcher or repair files. For known managed runtime replacement use `bootstrap --reinstall --yes` (optionally --node); preserve unknown files and invalid ownership records.

An entry at <repository>/.agents/skills/gidd/ locates its repository using its own path and local .git marker, including worktrees, independently of the current directory. Resolve the target repository before invoking scripts. Only this layout supplies an implicit target; client-managed user-level installations require an explicit target. Installing the skill or preparing a launcher does not enable any repository.

```powershell
& "<repository>\.agents\skills\gidd\gidd.cmd" bootstrap
& "<repository>\.agents\skills\gidd\gidd.cmd" bootstrap --yes
& "<repository>\.agents\skills\gidd\gidd.cmd" doctor
& "<repository>\.agents\skills\gidd\gidd.cmd" setup gh
& "<repository>\.agents\skills\gidd\gidd.cmd" identity
& "<repository>\.agents\skills\gidd\gidd.cmd" auth
```

Use `help en` / `help zh` for grouped usage; --help and -h are aliases and no arguments show help. Help also requires the generated launcher. Language follows the explicit argument, GIDD_LANG, then locale; unsupported system languages fall back to English. Commands preserve stdout/stderr and exit codes. Bootstrap has gidd.bootstrap/v1 output; ordinary argument errors use gidd.cli/v1 and exit 2. Operation protocols are in the references.

Use [references/doctor.md](references/doctor.md) for offline diagnosis. Doctor does not install, log in or write configuration. Its runtime item describes the current process, not a new compatibility check or runtime selection. Missing objects and not_checked results must not be called passed checks or failed login. local_ready does not establish enablement, identity or push access.

Use `config show` and `config set <key> <value>` with [references/configuration.md](references/configuration.md). Configuration is only <repository>/.agents/skills/gidd/config.toml; do not inherit user-level settings. Editable fields are github.hostname/account/remote, tool download sources, and tools.gh.version. Runtime versions and preference are internal: remove obsolete [bootstrap] and Bun/Node version fields when upgrading, preserving unrelated settings/comments. No min_version, bin or install-directory fields. First set creates the template; later edits preserve comments, unrelated fields, BOM and line endings. Editing does not prepare tools, log in or enable the repository. Identity/auth read required GitHub settings from the file without command overrides or inferred defaults.

When asked to check GitHub login, use identity and [references/identity.md](references/identity.md). It requires github.hostname/account/remote and performs read-only network checks. Report API identity, Git remote readability and commit author separately. Reading a public remote does not verify push permission. It does not log in, switch accounts or install missing tools.

For an explicit login request, use auth and [references/authorization.md](references/authorization.md). It requires github.hostname/account. Reuse a matching login; report a different existing account without switching. Display the attempt's URL and one-time device code, keep the waiting process and let the user authorize on any device. Verify actual API identity before reporting success. Do not open a browser automatically. gh manages credentials; configuration edits do not authorize account changes.

When tool preparation is authorized, use setup bun/node/gh and [references/setup.md](references/setup.md). These JS commands require an existing launcher and do not publish or switch it. setup without a selector reuses the executing runtime and prepares gh. Missing Bun defaults to stable, Node to LTS without npm; gh uses its version/source settings and requires 2.98.0+ for device authorization. Reuse tools; download missing ones using official checksums, and rerun doctor afterwards. Identity/auth do not install gh. Runtime repair and launcher recovery belong to bootstrap.

When copying the skill, exclude its root config.toml and config.toml.* edit files. Preserve the target's existing configuration; use assets/config.example.toml to create a new instance. Downloaded tools, installation records, launchers and caches stay in the fixed shared root, outside skill/source. That tree must not contain SKILL.md, config.toml or Git metadata; INSTALLATION.md describes ownership and cleanup.

For removal, identify the actual skill directory, repository config and shared root, and explain the scope. Removing one repository does not authorize shared-tool deletion. Full removal must explicitly include shared storage; other repositories may still use it. Never remove reused external tools or describe file deletion as GitHub logout/revocation.

Windows bootstrap, shared JS diagnosis/config/tool setup/identity/device authorization are implemented. Full skill installation/update, enablement records and Issue/PR business scripts remain unimplemented; do not claim they ran. Shared JavaScript must use standard APIs supported and tested by both Node and Bun.
