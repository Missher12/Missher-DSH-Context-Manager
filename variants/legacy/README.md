# Legacy build inputs

[中文说明与兼容要求](../../README.md) · [Compatibility and evidence](../../PUBLICATION.md)

These six files are exact copies from the accepted `0.10.0-local.9-legacy.1` stage. They replace the corresponding root files in a separate checkout: `package.json`, `COMPATIBILITY.json`, `cordis.patch.yml`, `src/version.ts`, `lib/index.js`, and `lib/engine.js`. All other product source, tests and runtime files are shared with the narrow build. This directory is not another plugin and is not installed beside the main package.

Legacy uses complete preset overrides and lacks the new Host request-error handoff for queued input. Its tested baseline does not establish universal compatibility. Published archives retain their frozen README bytes; rebuilding with the current Git documentation produces a different archive checksum.
