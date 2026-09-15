# YAML parser

`yaml.mjs` is an unminified ESM bundle of `yaml@2.9.1` by Eemeli Aro,
licensed under ISC; see `yaml.LICENSE`.

- Source: https://github.com/eemeli/yaml/tree/v2.9.1
- API documentation: https://eemeli.org/yaml/
- Package: https://registry.npmjs.org/yaml/-/yaml-2.9.1.tgz
- Published package integrity: `sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==`

The bundle exports `parseDocument` for resource loading and `stringify` for
development/tests. It is shipped with the skill so Node and Bun use the same
parser offline, without `node_modules` or an install step.

Rebuild from the repository root with `dev.cmd bun dev/vendor-yaml.mjs`
(generated with Bun 1.4.2). The build installs the pinned package into a temporary
directory with lifecycle scripts disabled, bundles its browser ESM entry, copies
the license, and removes that temporary directory. Review the generated diff when
updating the pinned version and package integrity above.
