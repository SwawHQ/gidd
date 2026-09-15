# GIDD-Managed Tools
This directory is created by [https://github.com/SwawHQ/gidd](https://github.com/SwawHQ/gidd) and serves as shared resources for all GIDD Skills.
The `.cache/` directory may be cleaned up when no GIDD Skill instance is running.
Other resources may be cleaned up when you are certain that no code repository is using GIDD Skill.
To repair, run `gidd.pre.ensure.cmd --repo <repository-path>` from the GIDD Skill installation directory.
Run `gidd.pre.ensure.cmd --help` for more usage information.

- `bun/`, `node/`, `gh/`, `git/`: Downloaded tools and related information.
- `bun.link.cmd`, `node.link.cmd`, `git.link.cmd`, `gh.link.cmd`: Independent tool launchers.
- `tool-bindings.json`: Git/gh bindings for GIDD commands.
- `.cache/`: Data related to downloads, locking, recovery, etc.
- `.runtime-path-*`: Links to external tools. Only delete the links themselves; do not delete the target files they point to.