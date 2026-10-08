# Missher DSH Context Manager

[中文](./README.md) | English

[Desktop](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [Downloads and releases](https://github.com/Missher12/Missher-DSH-Context-Manager/releases) · [Issues](https://github.com/Missher12/Missher-DSH-Context-Manager/issues)

Inspect per-session context composition, usage, compaction records and summary sources in DeepSeek Harness, and compact history before model requests when the configured threshold is reached. Optional idle compaction starts after a task completes normally and requires the host capability described below.

Package: `@missher/dsh-context-manager`. Source version: **0.10.0-local.1**, an uninstalled development candidate. This is a Cordis Bundle, not a Codex or Claude Code implementation. It adds verified tool-result reduction with a read-only original archive, per-session usage attribution in the inspector, and the settings that drive them, on top of configurable absolute working-history budgets (disabled by default; 200k → 100k as a validation starting point), lossless wrapper normalization, at most one exact string-to-array format repair per transaction, and per-attempt usage accounting through cancellation and bounded late delivery. A valid JSON checkpoint alone does not establish semantic fidelity.

The plugin now owns the final cancellation check and synchronous Session transaction. It no longer requires the added Basic capability marker or storage drain API. A private `.context-manager-recovery` directory under the active profile durably records pending usage/idle metadata before Host writes; restart reconciles the same attempt IDs without issuing model calls. It contains no conversation bodies. Conflicts or uncertain ownership fail closed. Usage never delivered before process exit stays unknown. Install only the frozen tarball listed in READY.md; root `lib` is an older artifact, not this candidate. This change does not alter Goal limits or MSE quotas.

## Tool-result reduction, original archive and usage attribution

Tool-result reduction starts in **observe** mode: it measures and records what the rule would do without touching a Host tool result. In **safe reduce** mode the plugin first stores the original in a read-only archive under the profile, then publishes the short text, and counts the reference as confirmed only when the Host's final result still carries it. Pending, reverted and confirmed references are shown separately; a character delta is a visible-text difference, never a token bill or a real saving. The input cap and the minimum saving in characters are settings; results above the cap or below the minimum saving stay verbatim.

The archive and its outcome rows are durable: `.context-manager-archive` lives in the profile directory, survives restarts, rebuilds confirmed/pending/reverted state from those rows and reconciles physical quota. The default **original-blob quota is 512 MiB**: it counts the recorded bytes of stored originals, including rows left behind by an interrupted or orphaned write and rows that no reference points at any more. Exhausting it disables new reduction and never deletes an existing original. The root manifest is excluded from that total, and each of the three JSONL manifests has its own bound (64 MiB and a row cap). So 512 MiB is not a directory total or a whole-archive quota. Cross-call dedup means one stored original can carry several references, so a reference is identified by original id plus call id. Every archive read path is read-only: neither the panel's session readout nor a status read creates the archive, writes a file or appends a session event.

Compacted or reduced originals remain reachable through `context_history_search` and `context_history_read`, bounded, paginated and position-accurate. The per-read budget and search result limit are settings and stay subject to each tool's own output limit. A forked session reads back only the originals its inherited prefix was actually granted, with declared limits on boundary, reference count, scanned events and total log size; anything beyond those limits is reported as incomplete instead of being passed off as coverage.

The cumulative card now shows usage attribution: business usage quoted from the Host projection, maintenance (summary and repair) usage, and the number of attempts that reported no usage. The Host's four buckets (uncached input, cache read, cache write, output) are mutually exclusive and are never added twice. When only some components were reported the figure is a **known lower bound** with its unknowns marked, and an all-unknown cut shows unknown rather than zero. The existing ledger has no durable purpose field, so summary and repair stay one undivided figure and cache-hit ratio uses only samples that reported every input component. Request-prefix diagnostics can be switched off without deleting any usage number.

A historical cut shows only attribution that has an event-log source: today's Host projection, ledger and archive results are never presented as old values, and quantities without a historical source read as unavailable for that cut.

## local.9 common recovery fix

One package serves all platforms. Windows keeps mandatory regular-file flushes and flushes the published file through a writable handle after atomic replacement; POSIX retains directory fsync. Flush/rename failures remain fatal and uncertain post-rename state refuses further writes until reopen. Windows permissions inherit the profile ACL; POSIX mode bits are not an ACL or sudden-power-loss guarantee. Native filesystem checks do not imply full Desktop or user-session acceptance.

Summary failures retain their native error type so the Host's existing image-offload hook can recognize an explicit image limit. Unknown errors do not gain automatic retries, and every physical summary call retains separate accounting.

## Working-set update

Automatic mode budgets recent verbatim history (20K by default) and a bounded checkpoint separately from fixed prompts, tool definitions and the current task. It does not target a fixed 50% or 100K total. Recent retention may shrink by complete tool groups when admission requires it. Saved percentage/absolute caps remain available in custom mode. Both preflight and the fully framed replacement must satisfy effective pressure and useful reduction checks.

Durable per-session source cycles allow at most two main summary plans and four total calls across steps/restarts; sufficient new original content is required to renew a cycle. Identical automatic requests cannot replay. Explicit manual retries still have a four-call transaction ceiling and at most one exact format repair. Permits are separate from actual per-call usage accounting.

Optional `context_history_read` / `context_history_search` tools retrieve original text from the executing session only, with exact positions and bounded pagination. No vector or external service is used. Each search covers at most 200 events / 32,768 characters and each JSON result is at most 8,000 characters; non-text data and uncovered ranges are explicit.

The native panel uses current TokenMeter admission when available; historical/unloaded/unknown reservation states stay unknown. Trends retain their estimated semantics. Structural validity is not a semantic-fidelity guarantee; real-model acceptance is recorded separately.

### local.2 session log integrity fix

Tool-result pruning now requires an open turn in the session log. Manual and idle maintenance skip this step while retaining valid checkpoint summaries, preventing out-of-turn tool replacements that strict V4 reload rejects. Protected pruning within a running turn is preserved. This prevents new invalid events; existing damaged logs require a separate backup-based recovery assessment and are not automatically rewritten.

## Host and platform requirements

The earlier 0.7 full tested baseline was **the custom Missher DeepSeek Harness Desktop 0.2.0-rc.2 on Intel macOS (x64)**, including maintenance-range selection and protected tool-result pruning. Plugin-level acceptance is not established for Windows, Linux, Apple Silicon, an unmodified official rc.2 host, or official 0.2.1-alpha.1. Availability of a desktop download does not establish plugin compatibility on that platform.

| Host condition | Behavior |
| --- | --- |
| Session, Projection, TokenMeter, StorageDomain, BasicCompactionEngine, Web conversation views, settings, Remote and shared UI services are available | Request-time compaction and the read-only inspector can load |
| DSH profile with an exclusively writable recovery directory | Plugin-owned final cancellation check and transaction, with write-ahead usage/idle metadata |
| Added Host cancellation, storage drain or selection hooks are missing | Uses the plugin transaction, journal and selection within the existing Agent maintenance lock |
| Custom embedding without a profile path | Requires Host storage drain support; otherwise stops before billing |
| `toolResultPruner.supportsProtectedSeqs === true` and the log has an open turn | Prunes older text tool results while protecting the current task, errors and non-text results; idle maintenance retains summaries and skips tool pruning |
| Protected-pruning capability is missing | Skips tool pruning and retains the ordinary summary path |

The Bundle does not impose a DSH version gate. This does not mean every version is compatible: missing mandatory services can still prevent activation. Optional capabilities degrade as above; no companion compatibility plugin is required. [COMPATIBILITY.json](./COMPATIBILITY.json) records the preset baseline and capabilities. Its `sourceSha` identifies preset source files, not full acceptance of an unmodified upstream build.

## Install and update

Prefer a prebuilt `.tgz` from [GitHub Releases](https://github.com/Missher12/Missher-DSH-Context-Manager/releases), and verify the SHA256 published for that release. It includes runnable entries and requires no local SDK or compilation. Use an asset that has actually been published.

Desktop: open **Plugins → Add plugin**, select the downloaded `.tgz` or enter its Release download URL. For the 0.8 development candidate, use only the accepted frozen tarball named in READY.md with its matching host. Git/folder installation would pick up the deliberately retained 0.7 runtime and is not a 0.8 installation.

The following command is the previous stable 0.7 release example, not the current candidate. For this candidate use only the frozen tarball in READY.md.

CLI/Web: replace `my-context` with your existing custom Web profile. Manage the reserved Desktop `desktop` profile inside the desktop application.

```sh
dsh plugin --profile my-context add https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.7.0-local.2/missher-dsh-context-manager-0.7.0-local.2.tgz
```

Keep the previous package and configuration, wait for active tasks to finish, and **fully restart the target application or profile** after updating. Confirm the version and all three active entries: `context-manager`, `context-manager-engine` and `context-manager-inspector`. Open **Context**, after **Trace**, in a session. An old process may cache package exports; a page refresh or enable toggle does not replace a restart. Do not enable both old and renamed packages.

The Bundle replaces the root Basic compactor and supplies compactor configuration for the Standard, PTC and Cordis presets; Minimal uses the root instance. The host replaces whole configurations by ID, so these presets are generated from the verified rc.2 snapshot and must be reviewed after host upgrades. User-saved overrides take precedence. Custom presets must explicitly replace `@deepseek-ai/dsh-compaction-basic` with `@missher/dsh-context-manager/engine`; installation does not take over every custom preset.

## Inspector and settings

One continuous panel uses native DSH controls and theme tokens:

- **Current context:** the model window, occupied content, unoccupied space and gray striped compaction reserve. Summaries, tools, messages and instructions have separate estimated token counts; unmatched host measurements appear as other usage. Reserve is derived from the current admission threshold, not permanently unusable capacity.
- **Changes and usage:** occupancy bars, before/after compaction, cumulative session tokens and cache hits. Summary calls have their own usage ledger, and compact attribution and tool-reduction status lines were added (details stay collapsed by default). Missing measurements remain unknown; cumulative tokens are neither current occupancy nor a bill, a partially reported total is marked as a known lower bound, and an all-unknown total reads as unknown.
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
| Summary output limit | 8192 tokens, also bounded by the actual model and request |
| Maximum compactions per request / summary timeout | 2 / 90 seconds |
| Idle compaction / idle delay | Enabled / 15 minutes |
| Minimum idle occupancy | Automatic: 65%; custom: max(65%, target + 10%); both capped by effective admission |
| Absolute working-history budget | Disabled; initial values 200,000 → 100,000 tokens |
| Format repair / output cap | Enabled / 2048 tokens, at most once per transaction |
| Additional summary focus | Empty, up to 2000 characters |
| Tool-result reduction mode | Observe (off / observe / safe reduce) |
| Tool-result input cap / minimum saving | 200,000 / 400 characters |
| Archive read budget / search result limit | 6,000 characters / 3 results |
| Request-prefix diagnostics | Enabled; read-only, never changes the request |

Percentage admission is `max(0, min(window × trigger ratio, window − output reserve − safety space) − early-check space)`. When enabled, the absolute trigger further caps admission without another early deduction. In custom mode only, the effective occupancy cap is the minimum of percentage target, 80% of percentage admission and the enabled absolute target. The model window remains its real capacity. Measurement happens after the new task joins the request, including system instructions and tool definitions. Compaction can therefore precede the main request. TokenMeter may estimate usage; the target is not an exact tokenizer or losslessness guarantee.

Summaries use the session's actual model and reasoning effort. They can incur provider charges and alter cache reuse. A checkpoint captures the goal, constraints, completed work, pending work, evidence, next action and uncertainties. Structural validation cannot guarantee semantic fidelity. Failure, cancellation, incomplete output, no reduction or exhausted passes stop the attempt instead of retrying indefinitely. Already committed tool pruning is not rolled back; original events remain queryable.

Idle timing starts at **normal task completion**, with bounded postponement for background work. New input, a model change, stop or disable invalidates an old plan. Each completion qualification can start at most one idle summary, durably recorded before the request. Restart restores only unattempted qualifications for registered sessions that are loaded again, with at least five seconds before rechecking. Requests with unknown outcomes are not blindly billed again. Nothing runs while the app is closed, and old sessions are not all scanned or activated.

Built-in official DeepSeek routes also show peak/off-peak periods and a cost comparison; third-party routes hide it. This uses the plugin's **2026-09-29 pricing-policy and 2026 calendar snapshot**, not a live price feed. Unknown models or years are not invented. Actual charges follow [DeepSeek's pricing documentation](https://api-docs.deepseek.com/quick_start/pricing/) and the provider bill.

## Disable, uninstall and data

- Turning off automatic compaction stops both request-time and idle automatic compaction; the hard context-window guard remains. Turning off only idle compaction keeps request-time compaction enabled. The inspector and the host's manual `/compact` command remain available.
- Disable the whole Bundle in plugin management and restart as directed by the host. Use the same manager to uninstall after active tasks finish. For CLI/Web, use `dsh plugin --profile my-context remove @missher/dsh-context-manager`.
- Removing or disabling the Bundle's overlay and restarting lets the host recreate its original presets and compactor. Restore Basic compactor references in any custom presets you edited before uninstalling. Do not remove only one of the three internal entries.
- There is no uninstall cleanup hook. Session logs retain original events, committed summaries and source references; this plugin does not actively delete them on uninstall. Completed compactions are not automatically reversed. Original content remains accessible through host queries or this inspector. **Referenced originals are retained the same way:** this version ships no cleanup action, retention switch or automatic deletion, and uninstalling does not remove the archive directory; back it up or handle it manually if you need to.
- The original archive stores only the text that a reduction referenced, under the profile's `.context-manager-archive`. A failed or over-quota write refuses publication instead of changing only memory. The archive holds no network copy beyond the conversation and uses no vector or external retrieval service. The default 512 MiB bounds the physical size of original blobs only; the metadata manifests have their own byte and row limits, so the directory total is not promised to be 512 MiB.
- Host `storageDomain` stores `context_manager_idle` for idle qualifications/status and `context_manager_summaries` for summary-call status/reported usage, and `context_manager_cycles` for request hashes, original-source watermarks and durable call permits. Failed summary raw output is not persisted; successfully committed output and references are in session logs. Unknown usage is not zero.
- Back up the target profile, plugin storage domains and session directory when upgrading or rolling back, not just the `.tgz`. No session migration is added by these metadata domains. The plugin does not maintain MSE long-term learning data or add a separate analytics endpoint. Summary input is sent through the host to the selected provider; host telemetry follows host settings.

## Validation and limitations

Historical evidence from 2026-10-03 includes 115 passing tests using real AgentLoop/JSONL/storage with a mock model, then 20 focused tests after a naming-only revision. Isolated custom rc.2 Loader/RPC and controlled Web validation covered light/dark themes, 1280/800/335px, source pagination, hidden composer and equal-height cards. A subsequent Intel macOS daily installation confirmed three active entries and read-only RPC.

The 0.10.0-local.1 candidate's offline evidence: both tsconfigs pass in the working tree and in the isolated candidate; the enhanced-SDK full regression, the legacy-SDK isolated subset, real codec round trips, service-to-codec reads, session isolation and historical-cut behaviour, built-client settings save/reload, and the archive read-only/session-scope assertions are recorded in `verification/context-efficiency-20261009/READY.md`. Browser screenshots, isolated Host loading and real-model benefit measurement are performed separately by the independent reviewer and are not complete. This candidate is not installed in the daily environment.

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
