# TOML parser

`toml.mjs` is an unminified ESM bundle of `smol-toml@1.7.2`, licensed under
BSD-3-Clause; see `toml.LICENSE`.

- Source and API: https://github.com/squirrelchat/smol-toml
- Package: https://registry.npmjs.org/smol-toml/-/smol-toml-1.7.2.tgz
- Package integrity: `sha512-pXFZ9B2WinEPzxWkMmlYE/oYx2BP+qLrE95wP8tCuK901uLSMGdCb6QSr82z+wnhXkG4+cO+OMLbZB2Cn+97zw==`

The bundle exports `parse` and `stringify`. It ships with the skill so Node and
Bun use the same TOML parser offline, without `node_modules` or an install step.

Rebuild with `dev.cmd bun dev/vendor-toml.mjs` (generated using Bun 1.4.2).
The build installs the pinned package in a temporary directory with lifecycle
scripts disabled, bundles its ESM entry, copies the license and removes the
temporary directory. Review the bundle, version and integrity when updating.
