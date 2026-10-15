# Skill validation parsers

`skill-parsers.mjs` bundles [js-yaml](https://github.com/nodeca/js-yaml)
5.4.3 and [marked](https://github.com/markedjs/marked) 18.1.0. Both use the
MIT license; see the adjacent license files.

These parsers are used only by development tests. Node and Bun run the same
offline checks without Python, PyYAML, npm or a dependency installation.

Rebuild with `dev.cmd bun dev/vendor-skill.mjs`. The script downloads pinned
packages, verifies their SHA-512 hashes, and builds in a temporary directory.
Package lifecycle scripts are disabled. The temporary directory is removed
after the build. Versions and expected hashes are recorded in the build script.
