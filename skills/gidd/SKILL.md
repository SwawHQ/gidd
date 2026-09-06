---
name: gidd
description: Diagnose GIDD prerequisites and prepare missing portable tools when the user asks to initialize GIDD or troubleshoot its environment. Currently supports Windows diagnosis and tool installation; repository configuration and Issue/PR workflows are not yet implemented.
license: MIT
---

# GIDD

Use [references/doctor.md](references/doctor.md) for Windows diagnosis, tool selection, output meanings, and follow-up guidance. The executable entry is `scripts/windows/doctor.ps1`; it works without Node.js or Bun installed.

When the user has authorized preparing missing tools, use [references/setup.md](references/setup.md) and `scripts/windows/setup-tools.ps1`. Explain the actual user-level `gidd.tools/` location. The installer reuses available runtimes and gh, downloads only missing tools, and can resume after interruption. Run doctor again afterwards; tool readiness does not enable the repository.

Resolve the user's target repository and the client's actual user skill root before invoking the script. Installing this skill at user scope does not enable any repository. Enablement and configuration require an explicit request for that repository.

The repository configuration belongs at `<repository>/.agents/skills/gidd/config.toml`. Do not inherit user-level configuration. GIDD-managed tools belong in the sibling user directory `<user skill root>/gidd.tools/`, which must not contain `SKILL.md` anywhere inside it.

Explain diagnostic facts and missing prerequisites. An available Node.js or Bun is sufficient; do not require both. `local_ready` means only that local prerequisites passed their documented checks, not that configuration or authentication is valid. A `not_checked` result is not a failed login.

TOML configuration, authentication, and GitHub development automation remain unimplemented. Do not claim they ran or infer authorization to install from a diagnostic failure. Future JavaScript logic must use standard APIs supported by both Node.js and Bun.

For a removal request, inspect the current repository's GIDD directory, the user-level `gidd/`, and `gidd.tools/`; explain the scope before removal. Removing GIDD from one repository does not authorize removal of shared tools. Do not remove externally managed tools or treat local file deletion as GitHub logout or authorization revocation.
