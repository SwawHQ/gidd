---
name: gidd
description: Diagnose GIDD prerequisites and prepare missing portable tools when the user asks to initialize GIDD or troubleshoot its environment. Currently supports Windows diagnosis and tool installation; tool storage configuration is supported; repository enablement and Issue/PR workflows are not yet implemented.
license: MIT
---

# GIDD

Use [references/doctor.md](references/doctor.md) for Windows diagnosis, tool selection, output meanings, and follow-up guidance. The executable entry is `scripts/windows/doctor.ps1`; it works without Node.js or Bun installed.

When the user has authorized preparing missing tools, use [references/setup.md](references/setup.md) and `scripts/windows/setup-tools.ps1`. Pass the explicit target repository. Explain the resolved tool directory from [references/configuration.md](references/configuration.md). The installer reuses available runtimes and gh, downloads only missing tools, and can resume after interruption. Run doctor again afterwards; tool readiness does not enable the repository.

Resolve the user's target repository before invoking scripts. The Agent manages where this skill is installed; GIDD does not record or detect its user-level or repository-level installation mode. Installing the skill does not enable any repository. Enablement and configuration require an explicit request for the target repository.

The repository configuration belongs at `<repository>/.agents/skills/gidd/config.toml`. Do not inherit user-level configuration. GIDD-managed tools default to `~/.agents/skills/gidd.tools/`, independently of the client. `tools.directory` specifies a home-relative, repository-relative or absolute path; the tool tree must not contain SKILL.md, config.toml or Git metadata. The node/bun/gh inline tables expose version policies and download roots. Missing tools default to Node LTS or stable Bun/gh; existing usable tools are reused without checking for updates. Exact versions must match. Show the resolved version and archive URL during installation; mirror archives still require official checksums. Version conflicts preserve existing directories; automatic upgrade/rollback is not implemented.

Explain diagnostic facts and missing prerequisites. An available Node.js or Bun is sufficient; do not require both. `local_ready` includes validation of the supported tool storage schema only; it does not validate enablement or authentication. A `not_checked` result is not a failed login.

Tool storage TOML is read without a JavaScript runtime; see the restricted schema and template in [references/configuration.md](references/configuration.md). Automatic config generation/editing, enablement, authentication, and GitHub development automation remain unimplemented. Do not claim they ran or infer authorization to install from a diagnostic failure. Future JavaScript logic must use standard APIs supported by both Node.js and Bun.

For a removal request, have the Agent identify the actual skill installation directory, then inspect it, the repository configuration, and the default and configured tool directories; explain the cleanup scope before removal. Removing GIDD from one repository does not authorize removal of shared tools. Do not remove externally managed tools or treat local file deletion as GitHub logout or authorization revocation.
