# Missher DSH Context Manager

[中文](./README.md) | English

[Desktop](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [Downloads and releases](https://github.com/Missher12/Missher-DSH-Context-Manager/releases) · [Issues](https://github.com/Missher12/Missher-DSH-Context-Manager/issues)

Inspect per-session context composition, usage, compaction records and summary sources in DeepSeek Harness, and compact history before model requests when the configured threshold is reached. Optional idle compaction starts after a task completes normally and requires the host capability described below.

Package: `@missher/dsh-context-manager`. Version: **0.8.0-local.9**. This is an independently installable Cordis Bundle with nine matching prebuilt runtime files. See [release and installation details](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/PUBLICATION.md). It provides configurable absolute working-history budgets (disabled by default; 200k → 100k as a validation starting point), lossless wrapper normalization, at most one exact string-to-array format repair per transaction, and per-attempt usage accounting through cancellation and bounded late delivery. A valid JSON checkpoint alone does not establish semantic fidelity.

The plugin owns the final cancellation check and synchronous Session transaction. It no longer requires the added Basic capability marker or storage drain API. A private `.context-manager-recovery` directory under the active profile durably records pending usage/idle metadata before Host writes; restart reconciles the same attempt IDs without issuing model calls. It contains no conversation bodies. Conflicts or uncertain ownership fail closed. Usage never delivered before process exit stays unknown. This change does not alter Goal limits or MSE quotas.

## Host and platform requirements

One package contains the shared implementation for all platforms. Native filesystem regression checks run on Windows, Ubuntu and macOS; the old Windows directory-fsync EPERM was reproduced and fixed. Full enhanced-SDK and targeted old-SDK regressions run on Intel macOS. [Publication details](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/PUBLICATION.md) separate these checks from complete desktop acceptance on a user device and real-provider summary quality.

Final cancellation, selection and usage recovery remain plugin-owned. Typed provider failures now reach the existing image-offload recovery hook; ordinary failures and cancellation do not automatically trigger retries.

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

For the Windows `EPERM ... fsync` failure and dependent `contextManager` / `compaction` waits, update the existing plugin, fully quit and restart DSH, then resume the original session. Do not delete sessions or recovery metadata. No platform-specific companion plugin is required.

Prefer a prebuilt `.tgz` from [GitHub Releases](https://github.com/Missher12/Missher-DSH-Context-Manager/releases), and verify the SHA256 published for that release. It includes runnable entries and requires no local SDK or compilation. Use an asset that has actually been published.

Desktop: back up the active profile and data, open **Plugins → Add plugin**, and select the [local.9 package](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.8.0-local.9/missher-dsh-context-manager-0.8.0-local.9.tgz) or paste its download URL. Update the existing plugin and reload or restart as requested. No companion compatibility package or Host replacement is required to supply the three added interfaces above. Installation runs no build script.

Back up `.context-manager-recovery`, `context_manager_idle`, `context_manager_summaries` and session data together. The journal may contain observed usage pending after the old Host closed storage; do not delete it to troubleshoot.

CLI/Web: replace `my-context` with your existing custom Web profile. Manage the reserved Desktop `desktop` profile inside the desktop application.

```sh
dsh plugin --profile my-context add https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.8.0-local.9/missher-dsh-context-manager-0.8.0-local.9.tgz
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
| Trigger / target occupancy | 80% / 55% |
| Early check / safety space | 1% / 2% |
| Summary output limit | 8192 tokens, also bounded by the actual model and request |
| Maximum compactions per request / summary timeout | 2 / 90 seconds |
| Idle compaction / idle delay | Enabled / 15 minutes |
| Minimum idle occupancy | Percentage floor is max(65%, target + 10%), capped by effective admission |
| Absolute working-history budget | Disabled; initial values 200,000 → 100,000 tokens |
| Format repair / output cap | Enabled / 2048 tokens, at most once per transaction |
| Additional summary focus | Empty, up to 2000 characters |

Percentage admission is `max(0, min(window × trigger ratio, window − output reserve − safety space) − early-check space)`. When enabled, the absolute trigger further caps admission without another early deduction. The effective target is the minimum of percentage target, 80% of percentage admission and the enabled absolute target. The model window remains its real capacity. Measurement happens after the new task joins the request, including system instructions and tool definitions. Compaction can therefore precede the main request. TokenMeter may estimate usage; the target is not an exact tokenizer or losslessness guarantee.

Summaries use the session's actual model and reasoning effort. They can incur provider charges and alter cache reuse. A checkpoint captures the goal, constraints, completed work, pending work, evidence, next action and uncertainties. Structural validation cannot guarantee semantic fidelity. Failure, cancellation, incomplete output, no reduction or exhausted passes stop the attempt instead of retrying indefinitely. Already committed tool pruning is not rolled back; original events remain queryable.

Idle timing starts at **normal task completion**, with bounded postponement for background work. New input, a model change, stop or disable invalidates an old plan. Each completion qualification can start at most one idle summary, durably recorded before the request. Restart restores only unattempted qualifications for registered sessions that are loaded again, with at least five seconds before rechecking. Requests with unknown outcomes are not blindly billed again. Nothing runs while the app is closed, and old sessions are not all scanned or activated.

Built-in official DeepSeek routes also show peak/off-peak periods and a cost comparison; third-party routes hide it. This uses the plugin's **2026-09-29 pricing-policy and 2026 calendar snapshot**, not a live price feed. Unknown models or years are not invented. Actual charges follow [DeepSeek's pricing documentation](https://api-docs.deepseek.com/quick_start/pricing/) and the provider bill.

## Disable, uninstall and data

- Turning off automatic compaction stops both request-time and idle automatic compaction; the hard context-window guard remains. Turning off only idle compaction keeps request-time compaction enabled. The inspector and the host's manual `/compact` command remain available.
- Disable the whole Bundle in plugin management and restart as directed by the host. Use the same manager to uninstall after active tasks finish. For CLI/Web, use `dsh plugin --profile my-context remove @missher/dsh-context-manager`.
- Removing or disabling the Bundle's overlay and restarting lets the host recreate its original presets and compactor. Restore Basic compactor references in any custom presets you edited before uninstalling. Do not remove only one of the three internal entries.
- There is no uninstall cleanup hook. Session logs retain original events, committed summaries and source references; this plugin does not actively delete them on uninstall. Completed compactions are not automatically reversed. Original content remains accessible through host queries or this inspector.
- Host `storageDomain` stores `context_manager_idle` for idle qualifications/status and `context_manager_summaries` for summary-call status/reported usage. Failed summary raw output is not persisted; successfully committed output and references are in session logs. Unknown usage is not zero.
- Back up the target profile, plugin storage domains and session directory when upgrading or rolling back, not just the `.tgz`. No session migration is added by these metadata domains. The plugin does not maintain MSE long-term learning data or add a separate analytics endpoint. Summary input is sent through the host to the selected provider; host telemetry follows host settings.

## Validation and limitations

Historical evidence from 2026-10-03 includes 115 passing tests using real AgentLoop/JSONL/storage with a mock model, then 20 focused tests after a naming-only revision. Isolated custom rc.2 Loader/RPC and controlled Web validation covered light/dark themes, 1280/800/335px, source pagination, hidden composer and equal-height cards. A subsequent Intel macOS daily installation confirmed three active entries and read-only RPC.

These are separate, dated validation layers, not fresh acceptance on every platform. Real-provider summary quality, long-task semantic retention, and native Windows/Linux execution remain unverified. Compaction retries do not completely rerun the host's dynamic `preStep` rule/plan assembly; files and task state must be checked through existing tools as needed. See the repository's [verification records](https://github.com/Missher12/Missher-DSH-Context-Manager/tree/main/verification).

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
