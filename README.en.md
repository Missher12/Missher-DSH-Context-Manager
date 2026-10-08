# Missher DSH Context Manager

[中文](./README.md) | English

[Desktop](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [Downloads and releases](https://github.com/Missher12/Missher-DSH-Context-Manager/releases) · [Issues](https://github.com/Missher12/Missher-DSH-Context-Manager/issues)

Inspect per-session context composition, usage, compaction records and summary sources in DeepSeek Harness, and compact history before model requests when the configured threshold is reached. Optional idle compaction starts after a task completes normally and requires the host capability described below.

Package: `@missher/dsh-context-manager`. Version: **0.9.0-local.1** (prerelease). This Cordis Bundle includes twelve matching prebuilt runtime files. It retains configurable absolute admission and custom-mode occupancy caps, lossless wrapper normalization, at most one exact string-to-array format repair per transaction, and per-attempt usage accounting through cancellation and bounded late delivery. A valid JSON checkpoint alone does not establish semantic fidelity.

The plugin now owns the final cancellation check and synchronous Session transaction. It no longer requires the added Basic capability marker or storage drain API. A private `.context-manager-recovery` directory under the active profile durably records pending usage/idle metadata before Host writes; restart reconciles the same attempt IDs without issuing model calls. It contains no conversation bodies. Conflicts or uncertain ownership fail closed. Usage never delivered before process exit stays unknown. This change does not alter Goal limits or MSE quotas.

## local.9 common recovery fix

One package serves all platforms. Windows keeps mandatory regular-file flushes and flushes the published file through a writable handle after atomic replacement; POSIX retains directory fsync. Flush/rename failures remain fatal and uncertain post-rename state refuses further writes until reopen. Windows permissions inherit the profile ACL; POSIX mode bits are not an ACL or sudden-power-loss guarantee. Native filesystem checks do not imply full Desktop or user-session acceptance.

Summary failures retain their native error type so the Host's existing image-offload hook can recognize an explicit image limit. Unknown errors do not gain automatic retries, and every physical summary call retains separate accounting.

## Working-set update

Automatic mode budgets recent verbatim history (20K by default) and a bounded checkpoint separately from fixed prompts, tool definitions and the current task. It does not target a fixed 50% or 100K total. Recent retention may shrink by complete tool groups when admission requires it. Saved percentage/absolute caps remain available in custom mode. Both preflight and the fully framed replacement must satisfy effective pressure and useful reduction checks.

Durable per-session source cycles allow at most two main summary plans and four total calls across steps/restarts; sufficient new original content is required to renew a cycle. Identical automatic requests cannot replay. Explicit manual retries still have a four-call transaction ceiling and at most one exact format repair. Permits are separate from actual per-call usage accounting.

Optional `context_history_read` / `context_history_search` tools retrieve original text from the executing session only, with exact positions and bounded pagination. No vector or external service is used. Each search covers at most 200 events / 32,768 characters and each JSON result is at most 8,000 characters; non-text data and uncovered ranges are explicit.

The native panel uses current TokenMeter admission when available; historical/unloaded/unknown reservation states stay unknown. Trends retain their estimated semantics. Structural validity is not a semantic-fidelity guarantee; real-model acceptance is recorded separately.

## Host and platform requirements

This release passed enhanced-SDK regression (235 passes, two old-only cases), natural old-SDK regression (48/48), and the current custom rc.2 Desktop Loader, installation, restart and read-only RPC checks on Intel macOS. The local.9 native filesystem checks on Windows, Ubuntu and macOS remain separately dated evidence. Complete Windows/Ubuntu Desktop workflows, Apple Silicon and real-model summary fidelity for the new working-set behavior still require acceptance. See [publication details](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/PUBLICATION.md).

| Host condition | Behavior |
| --- | --- |
| Session, Projection, TokenMeter, StorageDomain, BasicCompactionEngine, Web conversation views, settings, Remote and shared UI services are available | Request-time compaction and the read-only inspector can load |
| DSH profile with an exclusively writable recovery directory | Plugin-owned final cancellation check and transaction, with write-ahead usage/idle metadata |
| Added Host cancellation, storage drain or selection hooks are missing | Uses the plugin transaction, journal and selection within the existing Agent maintenance lock |
| Custom embedding without a profile path | Requires Host storage drain support; otherwise stops before billing |
| `toolResultPruner.supportsProtectedSeqs === true` | Prunes older text tool results first, protecting the current task, errors and non-text results |
| Protected-pruning capability is missing | Skips tool pruning and retains the ordinary summary path |

The Bundle does not impose a DSH version gate. This does not mean every version is compatible: missing mandatory services can still prevent activation. Optional capabilities degrade as above; no companion compatibility plugin is required. [COMPATIBILITY.json](./COMPATIBILITY.json) records the preset baseline and capabilities. Its `sourceSha` identifies preset source files, not full acceptance of an unmodified upstream build.

## Install and update

Prefer a prebuilt `.tgz` from [GitHub Releases](https://github.com/Missher12/Missher-DSH-Context-Manager/releases), and verify the SHA256 published for that release. It includes runnable entries and requires no local SDK or compilation. Use an asset that has actually been published.

Desktop: wait for active tasks to finish, back up the profile and data, open **Plugins → Add plugin**, and update the existing plugin using the [0.9 package](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.9.0-local.1/missher-dsh-context-manager-0.9.0-local.1.tgz) or its download URL. No companion plugin, SDK or local build is required.

Back up sessions, `context_manager_idle`, `context_manager_summaries`, the new `context_manager_cycles` domain, and `.context-manager-recovery` together. Retain cycle metadata when rolling back so a later upgrade does not forget duplicate-request protection. Do not restore an older snapshot over newer work.

CLI/Web: replace `my-context` with your existing custom Web profile. Manage the reserved Desktop `desktop` profile inside the desktop application.

```sh
dsh plugin --profile my-context add https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.9.0-local.1/missher-dsh-context-manager-0.9.0-local.1.tgz
```

Keep the previous package and configuration, wait for active tasks to finish, and **fully restart the target application or profile** after updating. Confirm the version and all three active entries: `context-manager`, `context-manager-engine` and `context-manager-inspector`. Open **Context**, after **Trace**, in a session. An old process may cache package exports; a page refresh or enable toggle does not replace a restart. Do not enable both old and renamed packages.

The Bundle replaces the root Basic compactor and supplies compactor configuration for the Standard, PTC and Cordis presets; Minimal uses the root instance. The host replaces whole configurations by ID, so these presets are generated from the verified rc.2 snapshot and must be reviewed after host upgrades. User-saved overrides take precedence. Custom presets must explicitly replace `@deepseek-ai/dsh-compaction-basic` with `@missher/dsh-context-manager/engine`; installation does not take over every custom preset.

## Inspector and settings

One continuous panel uses native DSH controls and theme tokens:

- **Current context:** the model window, occupied content, unoccupied space and gray striped compaction reserve. Summaries, tools, messages and instructions have separate estimated token counts; unmatched host measurements appear as other usage. Reserve is derived from the current admission threshold, not permanently unusable capacity.
- **Changes and usage:** occupancy bars, before/after compaction, cumulative session tokens and cache hits. Summary calls have their own usage ledger. Missing measurements remain unknown; cumulative tokens are neither current occupancy nor a bill.
- **Effective content:** initially four rows and two recent compaction records, with expansion and pagination. Summary sources follow stored references. Text pages contain up to 16,000 characters; images show references. The inspector does not preload every historical body.

The view does not activate an Agent, call a model or append session events. It hides only its conversation's composer and restores the draft when returning to the conversation. It does not poll full history or text bodies; only lightweight idle status refreshes while open. Analysis is bounded at 50,000 log events and reports an error beyond that limit. Host layout-marker changes require renewed validation of composer handling.

Edit parameters only in **Settings → Context Manager** and save. Updating the package does not overwrite saved values.

| Setting | Default |
| --- | --- |
| Automatic compaction master switch | Enabled |
| Trigger / retention mode | 80% / automatic working set |
| Recent text preference / summary output cap | 20K / 8,192 tokens |
| Saved custom occupancy cap (inactive by default) | 55% |
| Early check / safety space | 1% / 2% |
| Maximum compactions per request / summary timeout | 2 / 90 seconds |
| Idle compaction / idle delay | Enabled / 15 minutes |
| Minimum idle occupancy | Automatic: 65%; custom: max(65%, target + 10%); both capped by effective admission |
| Absolute soft trigger | Disabled; saved starting value 200,000 tokens; also applies in automatic mode when enabled |
| Absolute post-compaction occupancy cap | Saved at 100,000 tokens; only active in custom mode with the absolute budget enabled |
| Format repair / output cap | Enabled / 2048 tokens, at most once per transaction |
| Additional summary focus | Empty, up to 2000 characters |

Percentage admission is `max(0, min(window × trigger ratio, window − output reserve − safety space) − early-check space)`. When enabled, the absolute trigger further caps admission without another early deduction. In custom mode only, the effective occupancy cap is the minimum of percentage target, 80% of percentage admission and the enabled absolute target. The model window remains its real capacity. Measurement happens after the new task joins the request, including system instructions and tool definitions. Compaction can therefore precede the main request. TokenMeter may estimate usage; the target is not an exact tokenizer or losslessness guarantee.

Summaries use the session's actual model and reasoning effort. They can incur provider charges and alter cache reuse. A checkpoint captures the goal, constraints, completed work, pending work, evidence, next action and uncertainties. Structural validation cannot guarantee semantic fidelity. Failure, cancellation, incomplete output, no reduction or exhausted passes stop the attempt instead of retrying indefinitely. Already committed tool pruning is not rolled back; original events remain queryable.

Idle timing starts at **normal task completion**, with bounded postponement for background work. New input, a model change, stop or disable invalidates an old plan. Each completion qualification can start at most one idle summary, durably recorded before the request. Restart restores only unattempted qualifications for registered sessions that are loaded again, with at least five seconds before rechecking. Requests with unknown outcomes are not blindly billed again. Nothing runs while the app is closed, and old sessions are not all scanned or activated.

Built-in official DeepSeek routes also show peak/off-peak periods and a cost comparison; third-party routes hide it. This uses the plugin's **2026-09-29 pricing-policy and 2026 calendar snapshot**, not a live price feed. Unknown models or years are not invented. Actual charges follow [DeepSeek's pricing documentation](https://api-docs.deepseek.com/quick_start/pricing/) and the provider bill.

## Disable, uninstall and data

- Turning off automatic compaction stops both request-time and idle automatic compaction; the hard context-window guard remains. Turning off only idle compaction keeps request-time compaction enabled. The inspector and the host's manual `/compact` command remain available.
- Disable the whole Bundle in plugin management and restart as directed by the host. Use the same manager to uninstall after active tasks finish. For CLI/Web, use `dsh plugin --profile my-context remove @missher/dsh-context-manager`.
- Removing or disabling the Bundle's overlay and restarting lets the host recreate its original presets and compactor. Restore Basic compactor references in any custom presets you edited before uninstalling. Do not remove only one of the three internal entries.
- There is no uninstall cleanup hook. Session logs retain original events, committed summaries and source references; this plugin does not actively delete them on uninstall. Completed compactions are not automatically reversed. Original content remains accessible through host queries or this inspector.
- Host `storageDomain` stores `context_manager_idle` for idle qualifications/status and `context_manager_summaries` for summary-call status/reported usage, and `context_manager_cycles` for request hashes, original-source watermarks and durable call permits. Failed summary raw output is not persisted; successfully committed output and references are in session logs. Unknown usage is not zero.
- Back up the target profile, plugin storage domains and session directory when upgrading or rolling back, not just the `.tgz`. No session migration is added by these metadata domains. The plugin does not maintain MSE long-term learning data or add a separate analytics endpoint. Summary input is sent through the host to the selected provider; host telemetry follows host settings.

## Validation and limitations

This release passed enhanced-SDK build and Host/Client type checks, 235 tests (two old-only cases run separately), natural old-SDK 48/48, and 40 independent targeted tests. Isolated integration and Intel macOS daily installation passed: all 175 enabled Loader entries were active and 11 served client files matched. No real model was called. Exact package/source bindings and validation layers are in [PUBLICATION.md](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/PUBLICATION.md).

Synthetic long-task replay checks the protocol, source lookups, spacing, pairing and accounting, not real-provider summary fidelity, throughput or economic benefit. Complete Windows/Ubuntu Desktop, Apple Silicon and other upstream builds require separate acceptance. Compaction retries do not rerun all host dynamic `preStep` rule/plan assembly; check files and task state through existing tools as needed. Historical [verification records](https://github.com/Missher12/Missher-DSH-Context-Manager/tree/main/verification) retain their original scope.

## Independent development

Use Node 24 or a compatible host development environment, the pnpm version pinned in `package.json`, and a **separately built matching SDK**. Work in your own development copy, not a directory linked by a daily installation:

```sh
node scripts/link-harness.mjs /path/to/built-harness
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
npm pack --ignore-scripts
```

The linker creates this copy's explicit `harness-sdk` and development dependency links; it neither builds nor modifies the host. Relative SDK overrides in `pnpm-workspace.yaml` are development-only and excluded from the package. Test concurrency is one. Runtime dependencies use registry/host package names, with no machine-specific absolute paths or install hooks.

## License and sources

[MIT](./LICENSE). Generated presets and the settings layout derive from DeepSeek Harness and retain DeepSeek's attribution. The browser's bundled Zod MIT text is included in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). The compactor and shared UI are imported from the host rather than bundled with another plugin or compatibility package. `bowenliang123/dsh-context` informed research; its runtime source was not copied.
