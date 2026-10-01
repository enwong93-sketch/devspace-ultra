# Reviewed Pi dependency

`pi-coding-agent-0.86.1-devspace.1.tgz` is the npm-published MIT-licensed
`@earendil-works/pi-coding-agent@0.86.1` archive with **only** its
`npm-shrinkwrap.json` entry for `brace-expansion` changed from 5.0.9 to 5.0.12.
The original manifest, implementation, lifecycle scripts and bundled license
are unchanged. A byte-for-byte comparison covered all 1,100 files: exactly the
shrinkwrap differed, with no files added or removed.

The original archive and patch integrity values, reviewed archive hashes and
advisory are recorded in `pi-security-provenance.json`. The dependency-security
gate binds the root lock to that exact archive and checks the embedded
shrinkwrap. This is not a floating fork or a newer Pi implementation.

The upstream shrinkwrap still pins affected `brace-expansion` in Pi 0.99.2 and
1.0.0. Root overrides, `npm update`, `npm audit fix` and a changed root lock did
not change a clean installed tree. This reviewed archive fixes the dependency
at the point npm actually resolves it. A fresh isolated `npm ci --ignore-scripts`
installed 5.0.12 and the official registry audit reported zero vulnerabilities.
Release archive installation must also verify the actual installed tree; a
lock-only audit is not installation evidence.

The root `npm-shrinkwrap.json` is identical to the reviewed `package-lock.json`
and ships in the CLI release so native archive installs retain the tested
dependency graph, rather than re-resolving unrelated transitive versions.

Sources: the official npm registry packages and
<https://github.com/advisories/GHSA-q2hr-2g5m-vwhr>.
