---
description: "Inspect DeepSeek Harness session context and manage compaction when the host supports it."
kind: "package-bundle"
---

# Missher DSH Context Manager

[中文](./README.md) | English

[Desktop and plugin directory](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [Download](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/latest) · [Report an issue](https://github.com/Missher12/Missher-DSH-Context-Manager/issues)

`@missher/dsh-context-manager` is a DeepSeek Harness (DSH) plugin for inspecting session context, compaction history, summary sources and usage that may still be unknown.

One package adapts to actual host capabilities. Installation, inspection and enhanced compaction are separate capabilities; a broad dependency range does not guarantee every feature on every host.

## Features

- Inspect model capacity, context trends, compaction changes, effective content and summary sources in the session panel.
- On a supported host, check capacity before a request and optionally compact after a completed task becomes idle. Successful compaction resumes the task without repeating completed tool actions.
- Calculate budgets from the current model window and use either fixed deadlines or progress-based waiting. Unknown windows remain unknown.
- Track dispatch, results, commits and usage separately. Preserve interrupted work and unknown charges without automatically replaying old calls. Manual recovery requires a preflight and an explicit user action.
- Keep original tool output before publishing a reduced result. Observation is the default; failed, cancelled, timed-out or unverifiable results remain unchanged.

## Compatibility

| Host capability | Behavior |
| --- | --- |
| Complete public `compactionHost` v1, with this provider actually bound to the current Agent | Enhanced compaction, recovery and related actions |
| No supported interface, including the tested stock official alpha.5 and community rc.2 | Preserve the host compactor and user presets; allow read-only inspection and settings persistence without activating enhanced compaction |
| Custom presets, another provider or an unavailable binding | Report the actual binding; do not replace user choices or claim enhancement is active |

Dependency ranges allow multiple versions; runtime checks determine capabilities. Not every historical or future release has been tested. See [COMPATIBILITY-REPORT.json](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/COMPATIBILITY-REPORT.json) and [publication notes](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/PUBLICATION.md) for exact evidence. Pinned development SDKs reproduce builds and do not impose an exact runtime host version on users.

## Install or upgrade

1. Download the plugin `.tgz` from the [formal release](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/latest) and check its published SHA-256.
2. Install the file through DSH plugin management. This is a Bundle, not a desktop installer.
3. Restart normally when the host requests it. Open Context Manager in Settings and the session context panel.
4. Check the actual capability status. A successful save means settings persisted; it does not by itself prove enhanced compaction is active.

The neutral Bundle has only Manager and Inspector root entries. It does not copy host presets or require manually disabling Basic. Do not add a root Engine entry to reproduce an old entry count.

Upgrades preserve existing capacity modes and fixed deadlines. Choose percentage budgets or progress-based waiting explicitly before saving. Upgrading does not increase your budget or renew recovery allowances. The `variants/legacy` directory belongs to the historical rollback line; new installations use the current package.

## Common settings

These defaults apply to new installations. Existing saved values take precedence.

| Setting | Default |
| --- | --- |
| Pre-request checks | Enabled, with an 80% trigger subject to output reservations and safety headroom |
| Working history | Automatic; recent-original budget is 10% of the model window and summary output is 4%, within model and protocol caps |
| Waiting | 600 seconds total, 120 seconds for the first useful output, 180 seconds without useful output |
| Idle maintenance | Considered after a completed task has been idle for 15 minutes and reaches the occupancy threshold; does not run after the application closes |
| Tool-result reduction | Observe only; tool results are unchanged by default |

Automatic working sets do not promise a fixed total occupancy after compaction. History, system instructions, tools, the new message and output reservations all affect request admission.

Summaries consume model tokens. Missing usage remains unknown or a known lower bound, not free usage. Reduced character counts are not token savings. Deterministic wrapper repairs run locally without another model call.

## Data and recovery

Session originals, read-only tool archives, summary ledgers and recovery records stay in your profile. Read-only inspection must not start model calls, restore cold Agents or consume recovery authorization.

When automatic allowances run out, use the recovery preflight to inspect current conditions. Restarting or deleting records must not turn cancellation, unknown charges or uncertain commits into success. Back up sessions, originals, ledgers and new recovery records together; preserve data created after an upgrade before rolling back.

## Screenshots

Actual official alpha.5 Web UI with an isolated synthetic session. This host lacks the enhancement API, so the panel explicitly remains read-only and missing request usage stays unknown.

![Read-only context panel on the official host](https://raw.githubusercontent.com/Missher12/Missher-DSH-Context-Manager/v0.10.0-local.11/docs/screenshots/context-official-readonly.jpg)

The following image uses the actual plugin component with synthetic data to show occupancy, compaction changes and cumulative usage. It is a component preview, not native installation or real-provider evidence; its preview label is retained.

![Enhanced component preview with synthetic data](https://raw.githubusercontent.com/Missher12/Missher-DSH-Context-Manager/v0.10.0-local.11/docs/screenshots/context-enhanced-preview.jpg)

## Verification and development

[Publication notes](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/PUBLICATION.md) bind the exact release, source and package hashes, completed checks and limitations. Offline tests do not establish native UI behavior, paid-provider results or operation on another machine.

Source is in `src/`, tests in `tests/`, and build/platform checks in `scripts/`. Prepare the documented development SDK link and locked dependencies, then run `npm run typecheck`, `npm test` and `npm run build`. Follow the release-specific test instructions when updating. Installable runtime files are included; ordinary users should use the formal `.tgz` release.

License: [MIT](./LICENSE). See [third-party notices](./THIRD_PARTY_NOTICES.md).
