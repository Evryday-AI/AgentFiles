# Dependency and attribution review

Reviewed on 2026-10-10 for the Phase A source foundation. AgentFiles remains in preparation; this review does not establish clean deployment or release acceptance. The owner authorized MIT licensing of the original application source; publication remains separate from this local checkpoint. Third-party code and data retain their own licenses.

## Reproducible snapshot

The public `package-lock.json` fixes the resolved dependency versions and registry integrity values. The successful baseline used Node **24.21.0**, npm **11.19.0**, and Windows x64. Installation used `npm ci --no-audit --no-fund`, with separate empty user/global npm configuration files and the public `https://registry.npmjs.org/` registry. Database connection variables and `ESBUILD_BINARY_PATH` were removed from that process. No private application scripts, credentials, database or runtime were used.

Lockfile updates used `--package-lock-only --ignore-scripts --no-audit --no-fund`; the static plugin range was deliberately changed to `^10.1.6`, followed by a lockfile update without `--force`. These lock-only operations did not run dependency lifecycle hooks. The subsequent clean install did not use `--ignore-scripts`.

The installed inventory contains **268 package locations**. Another **50 lockfile locations** were absent on this platform, principally optional native packages for other platforms. Their names and versions are listed separately in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), without claiming that their license texts were inspected. Multiple locations can contain the same package/version.

The notice generator reads installed license/notice files recursively, including nested bundled licenses, without executing dependencies. It checks installed versions against the lockfile; it extracts the reviewed README/source notices and preserves explicitly labelled supplements. Its deterministic output contains 277 package attribution sections, plus the Argon2 copyright-bearing source comments. This section count includes shared upstream notices, upstream license supplements and package declarations; it is not a count of independent copyright owners or manually audited source files.

After a clean install on the intended distribution platform:

```sh
node scripts/generate-notices.mjs
node scripts/generate-notices.mjs --check
npm audit --json
npm audit --omit=dev --json
```

Review changes before distributing. The notice generator refuses missing required packages, an empty installed inventory, missing installed attribution and version mismatches before writing output. It does not fetch licenses or install packages. Supplemental texts and their public provenance are checked in at `docs/dependency-notice-supplements.json`. Update those supplements when the covered versions change. `--check` compares against the same platform's installed snapshot; cross-platform differences require review, not automatic replacement of a release's existing notices.

## Direct dependencies

D1 added exact development declarations `@apidevtools/swagger-parser@13.1.0`, `ajv@8.20.0`, and `ajv-formats@3.0.1` on 2026-10-11. Public npm metadata declares MIT for each and Swagger Parser requires Node >=22.19.0, compatible with the Node 24 target. The [official parser documentation](https://apidevtools.com/swagger-parser/) and [Ajv JSON Schema documentation](https://ajv.js.org/json-schema.html) informed the local OpenAPI 3.1/JSON Schema 2020-12 validation. External reference resolution is disabled. Swagger Parser is development-only; Ajv/Ajv-formats already belonged to Fastify's transitive runtime graph, as the notice inventory records. The contract scripts do not add a runtime integration requirement.

The D1 installed snapshot contains 279 package locations, 50 absent optional locations and 289 notice sections. All added installed package license/notice texts were inspected and regenerated with the deterministic notice generator; `--check` passed. MIT and an additional bundled Python-2.0 notice are preserved in the updated notices. Historical Phase A counts above describe that earlier snapshot.

The disposable Linux client test image uses the reviewed pinned Node image as its base and explicitly pins Debian tool packages: bash 5.2.15-2+b13, curl 7.88.1-10+deb12u15, jq 1.6-2.1+deb12u2, python3 3.11.2-1+b1 and coreutils 9.1-1. Versions came from the image's official Debian Bookworm package metadata. This test image is removed after verification and is not a distributed runtime artifact; Debian supplies its transitive package graph.

Versions below are installed resolutions, not the looser ranges in `package.json`.

| Purpose | Packages and resolved versions |
|---|---|
| HTTP server and plugins | fastify 5.12.5; @fastify/cookie 11.1.3; @fastify/multipart 9.4.0; @fastify/rate-limit 10.3.0; @fastify/static 10.1.6 |
| Password hashing, database and validation | argon2 0.44.0; pg 8.23.1; uuid 13.0.2; zod 4.6.5 |
| Browser application | react 19.3.0; react-dom 19.3.0 |
| Development/build/test | @vitejs/plugin-react 5.2.0; concurrently 9.2.5; jsdom 27.4.0; tsx 4.23.15; typescript 5.9.3; vite 7.3.7; vitest 4.1.11 |
| Type definitions | @types/node 24.19.2; @types/pg 8.23.1; @types/react 19.3.0; @types/react-dom 19.3.0 |

React is declared under development dependencies but is compiled into the distributed browser application, along with its scheduler dependency. A development flag in the lockfile does not mean a package's code cannot appear in a production artifact. The server build emits application JavaScript and keeps npm dependencies external; it needs the runtime dependency graph at execution.

## License texts and redistribution

[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) retains package-specific copyright lines and complete shipped license texts. The installed metadata labels include MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, MIT-0, 0BSD, CC0-1.0 and CC-BY-4.0. Bundled notices contain additional attributions such as Unicode; the metadata labels alone do not describe all bundled material.

Keep the AgentFiles MIT license and the applicable dependency notices with distributed source containing third-party material, browser builds, runtime packages and native artifacts. Preserve package license/NOTICE files when copying dependencies. A browser build must have an accessible accompanying notice file, even if minification retains only some comment banners. Carrying this complete notice snapshot is a conservative way to retain attribution; inclusion does not mean that every listed development dependency is bundled in the application.

MIT/ISC notices retain their copyright and permission terms. BSD notices include their redistribution conditions and disclaimers. Apache material requires the license and applicable notices, and changed files must be identified when modified. Preserve the full bundled notices rather than reducing an artifact to its top-level license label. The copied third-party notice texts are unchanged apart from line-ending/trailing-whitespace normalization and Markdown framing; dependencies themselves have not been patched by AgentFiles.

The review specifically covered these exceptions and packaged components:

- **Browser code:** React, React DOM and scheduler are MIT, with Meta Platforms, Inc. and affiliates' copyright notices. Their full installed licenses are reproduced.
- **Native password hashing:** `argon2@0.44.0` has an MIT npm wrapper, copyright 2015 Ranieri Althoff. `argon2/argon2/LICENSE` contains both complete CC0 1.0 and Apache 2.0 texts for the bundled reference implementation. Its source credits Daniel Dinu, Dmitry Khovratovich, Jean-Philippe Aumasson and Samuel Neves (2015); `encoding.c` separately credits Thomas Pornin (2015) under CC0. These notices apply to the implementation included in native builds, not just the JavaScript wrapper. The MIT Node.js API collaborators' notice from node-addon-api is also preserved.
- **Build datasets:** `caniuse-lite@1.0.30001815` uses CC BY 4.0. Attribution: the Can I Use contributors and the caniuse-lite project (Ben Briggs and contributors); sources [Can I Use](https://caniuse.com/) and [caniuse-lite](https://github.com/browserslist/caniuse-lite); [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). AgentFiles makes no modifications to the installed dataset. The full license accompanies that attribution. `mdn-data@2.27.1` is CC0; `baseline-browser-mapping@2.11.28` is Apache 2.0. These build/test datasets are accounted for without claiming that their raw data is shipped in the browser bundle.
- **Bundled tools:** The full license files from Vite, Vitest, Rollup and tsx, and TypeScript's `ThirdPartyNoticeText.txt`, are retained. They include licenses and copyright lines for bundled components that need not be separately represented in the npm lockfile. TypeScript's Apache license and tslib's Microsoft copyright notice are preserved.
- **Platform binaries:** esbuild 0.28.2 and Rollup 4.64.5 platform packages omit their own license files; their notices are taken from the matching installed parent releases and labelled as shared. The Windows esbuild executable records Go 1.26.5, so the matching Go BSD license is included as a supplemental notice. This is a review of the installed packages' shipped notices and these identified embedded components; other-platform binaries and container OS packages require review with their actual release artifacts.
- **Missing packaged license files:** pg-types 2.2.0 and pgpass 1.0.5 ship their complete MIT notices in their READMEs; those sections are reproduced. saxes 6.0.0 omits its ISC license from the npm artifact; the exact upstream license at the registry's public `gitHead` is preserved, including the original sax attribution and its historical Mathias Bynens notice. @epic-web/invariant 1.0.0, abstract-logging 2.0.1 and stackback 0.0.2 declare MIT without shipping a full MIT notice. Their installed author/license declarations and separately labelled standard MIT terms are retained; no absent copyright year or copyright line has been invented. stackback's `formatstack.js` additionally contains the V8 project authors' 2012 BSD three-clause notice, reproduced in full. It is not covered by a blanket MIT assertion.

## Install-time code review

Only two installed registry packages declare install-time hooks:

| Package | Hook | Reviewed behavior |
|---|---|---|
| argon2 0.44.0 | `install: cross-env ZERO_AR_DATE=1 node-gyp-build` | cross-env sets the reproducible archive timestamp variable and starts node-gyp-build. That loader tests a matching native prebuild; if absent/unloadable or source-building is requested, it launches node-gyp rebuild. The reviewed binding configuration compiles the included Argon2 C/C++ sources and node-addon-api headers. A fallback source build can require a local compiler/toolchain and Node headers; it is not a pure JavaScript install. |
| esbuild 0.28.2 | `postinstall: node install.js` | Selects the platform binary, respects an explicit binary-path override, validates its reported version, and can optimize the binary link on supported non-Windows platforms. If the optional binary is absent, it can spawn npm to install that exact platform/version or download its tarball from the public registry. The fallback paths verify the binary against the package's SHA-256 hashes before writing it. The reviewed direct download code follows redirects. |

Argon2's script and node-gyp-build's helper scripts match the previously inspected registry copies. The actual esbuild 0.28.2 script was inspected after this clean install; relative to the previously inspected 0.28.0 script, it adds a nonnegative tar-entry-size guard and package context to an integrity mismatch diagnostic. The previous version's review is not represented as a pre-install review of 0.28.2. No dependency hook was manually run during the notice review.

The clean install completed but npm warned that these two packages were not yet covered by `allowScripts`. That warning is **not proof that hooks were skipped**: the actual installed npm 11.19.0 Arborist implementation returns `null` for unreviewed scripts and skips only explicit `false` denials. With the recorded install flags/configuration, unreviewed hooks were permitted to run. Individual hook invocation was not separately logged, so this evidence does not prove whether each native fallback branch ran.

The official [npm install-scripts documentation](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/) describes default blocking, while the older [approve-scripts documentation](https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/) describes an advisory transition. The version-specific local implementation resolves that discrepancy for this run. `package.json` has no `allowScripts` approvals recorded. Recheck the npm version and script policy before later installation; record version-specific approval/denial decisions after reviewing the actual resolved scripts. Do not treat successful installation or lack of foreground hook output as approval-policy evidence.

The lockfile also lists fsevents and other optional platform packages not installed here. Their historical inspection is not treated as a review of every absent package or a successful install on another platform. Source-only registry `prepare`/test/build scripts listed by packages are not automatically registry dependency install hooks.

## Security and verification evidence

The earlier planning audit reported 16 affected packages, including six runtime high-severity findings. It is historical evidence for the original resolutions. After compatible dependency remediation, the fresh `npm audit --json` and `npm audit --omit=dev --json` both reported **zero vulnerabilities** on 2026-10-10; no lower-severity exception is needed for that snapshot. npm's metadata reports 318 graph locations, including optional entries, while the inspected installation contains 268 locations. An audit graph count is not an inspected-license count.

The Phase A baseline passed 102 tests in 12 files, the server and browser no-emit typechecks, and the build. These checks use synthetic fixtures and do not establish a deployed system's security or later clean-install acceptance. Full command outcomes and the scoped acceptance boundary are recorded in [Phase A verification](verification/phase-a.md). Future dependency changes require renewed advisory, hook and notice review.
