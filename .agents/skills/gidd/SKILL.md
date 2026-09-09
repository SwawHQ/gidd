---
name: gidd
description: Diagnose GIDD prerequisites, configure repository GitHub settings, check identity, request device authorization when explicitly asked to log in, and prepare missing portable tools. Currently verified on Windows; repository enablement and Issue/PR workflows are not yet implemented.
license: MIT
---

# GIDD

Read [references/bootstrap.md](references/bootstrap.md) for startup behavior: each command first reuses a qualified managed runtime, then PATH, and otherwise prepares bootstrap.runtime (Bun by default). PowerShell only handles startup; shared JavaScript owns diagnosis, configuration, tool setup and GitHub operations.

Use the installed skill's `gidd.cmd` on Windows. Run `gidd.cmd help en` (or `help zh`) for usage; the entry automatically prepares Node.js or Bun if necessary, including before help and doctor. Tell the user about runtime preparation before their first invocation; it may download to the fixed shared tool directory. An entry at `<repository>/.agents/skills/gidd/` locates that repository using its own path and a local `.git` marker, independently of the working directory. `--help` and `-h` are aliases of `help`. Linux/macOS launchers are not yet implemented or verified.

```powershell
& "<repository>\.agents\skills\gidd\gidd.cmd" doctor
& "<repository>\.agents\skills\gidd\gidd.cmd" setup bun
& "<repository>\.agents\skills\gidd\gidd.cmd" setup node
& "<repository>\.agents\skills\gidd\gidd.cmd" setup gh
& "<repository>\.agents\skills\gidd\gidd.cmd" identity
& "<repository>\.agents\skills\gidd\gidd.cmd" auth
```

Use [references/doctor.md](references/doctor.md) for offline diagnosis, tool selection, output meanings, and follow-up guidance. JavaScript doctor does not install tools, log in or write configuration; its preceding stage0 may prepare a runtime. A stage0 failure means doctor did not run.

Use `config show` to inspect repository configuration. When asked to configure it, use `config set <key> <value>` for the documented GitHub and tool fields. A common setting is `github.account`; see the configuration reference for the complete list. Stage0 supplies one Node/Bun runtime (editing can reuse a version above the skill minimum even when a new pin does not match). bootstrap.runtime is also editable; use bun or node. First set creates the template; subsequent edits preserve unrelated settings, inline-table companion fields and comments. The JS edit does not install, upgrade or move tools; preceding startup may prepare its runtime. Unknown fields and schema_version are not editable. Identity/auth read these fields only from config.toml, with no command-line overrides or implicit defaults. Missing fields must be explicitly set before continuing. See [references/configuration.md](references/configuration.md) for validation, file locks and output. Editing identity settings does not authorize login or account switching.

When the user asks to check GitHub login for a repository, use `identity` and [references/identity.md](references/identity.md). Require github.hostname, github.account and github.remote in repository config.toml. This performs read-only network checks using an available Node.js or Bun; it does not log in, switch accounts or enable the repository. Report API identity, Git remote readability and commit author separately. A readable public remote does not verify Git authentication or push permission.

For an explicit login/authorization request, use `auth` and [references/authorization.md](references/authorization.md). Read github.hostname and github.account from repository config.toml, show this attempt's URL and code, retain the waiting process, and verify the resulting API identity. Reuse a matching login; report an existing account mismatch without switching. Credentials are managed by gh, not GIDD configuration. A login request does not enable the repository.

When the user has authorized preparing missing tools, use `setup bun`, `setup node` or `setup gh` and [references/setup.md](references/setup.md). Explain the fixed shared tool directory from [references/configuration.md](references/configuration.md). Without a selector, setup prepares one runtime and gh; after stage0, a selector prepares that specific tool. With no usable runtime, stage0 still prepares the configured default first. Use `setup gh` when preparing device authorization (gh 2.98.0+). The installer reuses available tools, downloads only missing tools, and can resume after interruption. Run doctor again afterwards; tool readiness does not enable the repository. Identity/auth do not automatically install gh; their stage0 can prepare a runtime. Node defaults to LTS and includes only its runtime and license, without npm.

The shell entry preserves each operation's JSON and exit codes; argument errors use `gidd.cli/v1` with exit 2. Help is plain text, grouped by purpose with descriptions beside commands. Language selection follows the help argument, GIDD_LANG, then LC_ALL / LC_MESSAGES / LANG / Windows UI language; unsupported system languages fall back to English. Read the relevant reference for operation-specific results.

Resolve the user's target repository before invoking scripts. The Agent manages where this skill is installed; GIDD does not record an installation mode in configuration. Only the repository layout described above supplies an implicit target. Installing the skill does not enable any repository. Enablement and configuration require an explicit request for the target repository.

When copying this skill to another repository, exclude its root `config.toml` and `config.toml.*` lock/temporary files. They belong to the source repository. Preserve the target's existing configuration; use `assets/config.example.toml` when creating a new one. Downloaded tools remain outside the skill.

The repository configuration belongs at `<repository>/.agents/skills/gidd/config.toml`. Do not inherit user-level configuration. GIDD-managed tools are stored at the fixed `~/.agents/skills.tools/gidd/`, independently of the repository or client; the tool tree must not contain SKILL.md, config.toml or Git metadata. The node/bun/gh inline tables expose version policies and download roots. Missing tools default to Node LTS or stable Bun/gh; existing usable tools are reused without checking for updates. Exact versions must match. Show the resolved version and archive URL during installation; mirror archives still require official checksums. Version conflicts preserve existing directories; automatic upgrade/rollback is not implemented.

Explain diagnostic facts and missing prerequisites. An available Node.js or Bun is sufficient; do not require both. `local_ready` includes validation of the supported tool storage schema only; it does not validate enablement or authentication. A `not_checked` result is not a failed login.

Stage0 reads the necessary startup configuration without a JavaScript runtime; full parsing/editing is JavaScript; see the restricted schema and template in [references/configuration.md](references/configuration.md). Explicit config show/set is implemented; full skill installation/update, enablement and GitHub development automation remain unimplemented. Full repository-only installation remains tracked in Issue #14. Schema v1 configures tool versions/sources and GitHub settings; the shared storage path is not configurable. Do not claim these unimplemented workflows ran. Runtime bootstrap is part of invoking the entry; gh setup and login remain separate requested operations. JavaScript logic must use standard APIs supported by both Node.js and Bun.

For a removal request, have the Agent identify the actual skill installation directory, then inspect it, the repository configuration, and the fixed shared tool directory; explain the cleanup scope before removal. Removing GIDD from one repository does not authorize removal of shared tools. Do not remove externally managed tools or treat local file deletion as GitHub logout or authorization revocation.
