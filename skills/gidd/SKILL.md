---
name: gidd
description: Diagnose GIDD prerequisites, configure repository GitHub settings, check identity, request device authorization when explicitly asked to log in, and prepare missing portable tools. Currently verified on Windows; repository enablement and Issue/PR workflows are not yet implemented.
license: MIT
---

# GIDD

Use the installed skill's `gidd.cmd` on Windows. Run `gidd.cmd help en` (or `help zh`) for usage; help, diagnosis and tool preparation work without Node.js or Bun. An entry at `<repository>/.agents/skills/gidd/` locates that repository using its own path and a local `.git` marker, independently of the working directory. `--help` and `-h` are aliases of `help`. Linux/macOS launchers are not yet implemented or verified.

```powershell
& "<repository>\.agents\skills\gidd\gidd.cmd" doctor
& "<repository>\.agents\skills\gidd\gidd.cmd" setup bun
& "<repository>\.agents\skills\gidd\gidd.cmd" setup node
& "<repository>\.agents\skills\gidd\gidd.cmd" setup gh
& "<repository>\.agents\skills\gidd\gidd.cmd" identity
& "<repository>\.agents\skills\gidd\gidd.cmd" auth
```

Use [references/doctor.md](references/doctor.md) for offline diagnosis, tool selection, output meanings, and follow-up guidance. `doctor` does not install tools, log in or write configuration.

Use `config show` to inspect repository configuration. When asked to configure it, use `config set <key> <value>` for the documented GitHub and tool fields. Common settings are `github.account` and `tools.directory`; see the configuration reference for the complete list. These commands require one Node/Bun runtime (editing can reuse an installed version even when a new pin does not match); use the authorized setup command first if missing. First set creates the template; subsequent edits preserve unrelated settings, inline-table companion fields and comments. Setting tool paths, versions or sources does not install, upgrade or move tools. Unknown fields and schema_version are not editable. Identity/auth read these fields only from config.toml, with no command-line overrides or implicit defaults. Missing fields must be explicitly set before continuing. See [references/configuration.md](references/configuration.md) for validation, file locks and output. Editing identity settings does not authorize login or account switching.

When the user asks to check GitHub login for a repository, use `identity` and [references/identity.md](references/identity.md). Require github.hostname, github.account and github.remote in repository config.toml. This performs read-only network checks using an available Node.js or Bun; it does not log in, switch accounts or enable the repository. Report API identity, Git remote readability and commit author separately. A readable public remote does not verify Git authentication or push permission.

For an explicit login/authorization request, use `auth` and [references/authorization.md](references/authorization.md). Read github.hostname and github.account from repository config.toml, show this attempt's URL and code, retain the waiting process, and verify the resulting API identity. Reuse a matching login; report an existing account mismatch without switching. Credentials are managed by gh, not GIDD configuration. A login request does not enable the repository.

When the user has authorized preparing missing tools, use `setup bun`, `setup node` or `setup gh` and [references/setup.md](references/setup.md). Explain the resolved tool directory from [references/configuration.md](references/configuration.md). Without a selector, setup prepares one runtime and gh; select a tool to prepare only that tool. Use `setup gh` when preparing device authorization (gh 2.98.0+). The installer reuses available tools, downloads only missing tools, and can resume after interruption. Run doctor again afterwards; tool readiness does not enable the repository. Identity/auth report missing dependencies without automatically installing them. Node defaults to LTS and includes only its runtime and license, without npm.

The shell entry preserves each operation's JSON and exit codes; argument errors use `gidd.cli/v1` with exit 2. Help is plain text, grouped by purpose with descriptions beside commands. Language selection follows the help argument, GIDD_LANG, then LC_ALL / LC_MESSAGES / LANG / Windows UI language; unsupported system languages fall back to English. Read the relevant reference for operation-specific results.

Resolve the user's target repository before invoking scripts. The Agent manages where this skill is installed; GIDD does not record an installation mode in configuration. Only the repository layout described above supplies an implicit target. Installing the skill does not enable any repository. Enablement and configuration require an explicit request for the target repository.

The repository configuration belongs at `<repository>/.agents/skills/gidd/config.toml`. Do not inherit user-level configuration. GIDD-managed tools default to `~/.agents/skills/gidd.tools/`, independently of the client. `tools.directory` specifies a home-relative, repository-relative or absolute path; the tool tree must not contain SKILL.md, config.toml or Git metadata. The node/bun/gh inline tables expose version policies and download roots. Missing tools default to Node LTS or stable Bun/gh; existing usable tools are reused without checking for updates. Exact versions must match. Show the resolved version and archive URL during installation; mirror archives still require official checksums. Version conflicts preserve existing directories; automatic upgrade/rollback is not implemented.

Explain diagnostic facts and missing prerequisites. An available Node.js or Bun is sufficient; do not require both. `local_ready` includes validation of the supported tool storage schema only; it does not validate enablement or authentication. A `not_checked` result is not a failed login.

Tool storage TOML is read without a JavaScript runtime; see the restricted schema and template in [references/configuration.md](references/configuration.md). Explicit config show/set is implemented; full skill installation/update, enablement and GitHub development automation remain unimplemented. Repository-only installation and shared tool path migration are tracked in Issue #14; tool storage fields remain unchanged; schema v1 now also accepts the github table. Do not claim they ran or infer authorization to install or log in from a diagnostic failure. JavaScript logic must use standard APIs supported by both Node.js and Bun.

For a removal request, have the Agent identify the actual skill installation directory, then inspect it, the repository configuration, and the default and configured tool directories; explain the cleanup scope before removal. Removing GIDD from one repository does not authorize removal of shared tools. Do not remove externally managed tools or treat local file deletion as GitHub logout or authorization revocation.
