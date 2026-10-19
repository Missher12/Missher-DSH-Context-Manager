# 2026-10-19 Context 0.10.0-local.16 plugin candidate: RC.2 native Input styling fix

Local candidate: `@missher/dsh-context-manager` **0.10.0-local.16**. This version inherits local.15's approved Settings, session Context and Run details UI and only fixes duplicate styling on the RC.2 native Input. It remains a local candidate, not a formal Release or installation.

This project ships a Cordis Bundle plugin. It does not modify DeepSeek Harness Host source or add a compatibility plugin. The Bundle inserts Context Manager and the read-only Inspector without snapshotting or rewriting Host presets. Host provider-registration API v1 affects enhanced provider registration only; when absent, the plugin does not replace or disable Host Basic. Offline integration with the frozen RC.2 Loader and a synthetic adapter verified that default Basic remains, Context request/idle sidecars cooperate, and Basic performs its own overflow recovery. Basic keeps its own thresholds, costs and accounting; Context's two-main-summary/four-call limits do not cover Basic, and the plugin does not promise that every window needs only one compaction.

Budget arithmetic covered 32K, 64K, 100K, 200K and 1M Token windows. The 100K multi-round semantic oracle uses fixed facts and synthetic summaries to check corrections, constraints, pending work, failure evidence, source pairing, reload and single side effects. It does not establish the quality of arbitrary real-model summaries. The final checkpoint total in that replay was at most 4K Tokens; this does not mean every intermediate snapshot or tokenizer was tested.

Local.15 targeted tests and synthetic preview evidence are inherited by local.16; that preview uses RC.1 development primitives and does not prove the RC.2 native Input appearance. Desktop still needs to verify local.16 focus, error and disabled states in the actual Host. Local.14 remains the installation baseline. See `PUBLICATION.md` and `COMPATIBILITY.json` for the candidate boundary.

Real-provider summary quality, actual billing, Host-native settings persistence, native Electron UI, natural Host/upgrade behavior, formal Release and installation remain separate pending checks. A synthetic adapter or package artifact cannot stand in for them.

## Inherited local.9 scope

- **A Format normalization and structural repair:** checkpoint structure is validated strictly. Only a proven single-string value in an array field is wrapped locally, with no extra model call. Other structural errors are rejected and the original remains intact.
- **B Working-set growth and continuation headroom:** dynamic working-set retention and continuation headroom are checked against the fully framed input before dispatch and commit.
- **C Status and usage accounting:** dispatched and undispatched attempts are separate; `not_dispatched` does not count as unknown usage, while dispatched attempts without complete usage remain unknown.
- **D Versioned checkpoint:** sections use `context-manager/3` and require explicit opt-in; JSON remains the default. Structural validity does not establish semantic fidelity.
- **E Tool-result de-load:** a constrained path is implemented for successful foreground Bash output only: nonempty cwd, exit code 0, not cancelled or timed out, no signal, complete stdout/stderr, and empty stderr. A deterministic repeated-line rule makes no model call; the original is stored in the read-only archive first, and publication is counted only if the final Host result still carries the reference. `toolResultsMode` defaults to `observe`; the UI must be explicitly set to **Safe reduce** (`reduce`) before content changes. Other tools and failed or incomplete results pass through unchanged. There is no vector database or promise of actual Token or cost savings.
- **F Preset integration:** local.13 keeps the Host-declared provider and uses an optional Context sidecar when the actual Agent is bound to Basic. The frozen RC.2 Loader checks include native Basic preservation and overflow recovery with a synthetic adapter; natural Host runtime, real-model quality and native UI remain pending.

## Public interface gallery

This candidate has no public PNG gallery. Local.15 completed a synthetic UI preview for layout review; it does not establish RC.2 Host-native UI acceptance. The public gallery still needs a separate visual pass with generation details and SHA checksums.

## Historical note: local.8 (2026-10-13)

### local.8 automatic-compaction candidate (historical)

This candidate implements deterministic structural repair with zero extra model calls, continuation headroom with a hard feasibility gate, separate dispatched/physical/candidate/applied/usage accounting with no blind replay, and an opt-in versioned sections checkpoint (json remains the default), plus read-only status-line metrics. E (tool de-load) and F (narrow preset) are not implemented because the host exposes no public contract; gap notes and a host patch candidate are recorded. Not installed, not published, no paid model acceptance. See `verification/automatic-compaction-20261013/READY.md`.

**Repair-field compatibility (from local.7)**: when the structure check proves an array field was written as a single string, the program wraps the exact value locally and commits it with **zero extra model calls and no second charge**. `formatRepairEnabled` only gates that local repair. `repairPercent` and `formatRepairMaxTokens` remain readable from old configurations but do not trigger model calls or usage charges; Settings preserves their compatibility data without exposing separate controls. Older release notes below that mention resending failed output or a repair model call describe superseded behavior.

The local.6 notes below are historical.

# local.6 template-compatibility revision (2026-10-12)

Historical local.6 removed three `Your working directory is {{cwd}}.` clauses for official alpha.2. Static source inspection now confirms that official rc.2 registers the `cwd` prompt variable and official alpha.2 does not; the working-directory service context is not a substitute for template interpolation. The local.10 generator detects registration from the target AgentLoop source: it keeps the sentence for rc.2 and removes only the exact legacy persona clause for targets without registration, failing closed on other unresolved `{{cwd}}` references in full snapshots. This historical note does not claim local.10 runtime acceptance.

The 16 runtime lib files remain byte-identical with frozen local.5 and `src/engine.ts`/`src/summary-operations.ts` are untouched; package version local.6 marks the overlay revision only and runtime engine diagnostics remain frozen local.5. This revision does not carry the alpha.2 time-context/tool-schedule additions or its plan-mode and tool-subagent toolFilter changes, so it makes no full-plugin alpha.2 compatibility claim; see COMPATIBILITY.json and `verification/cwd-template-20261012/READY.md`. Not installed, not published, no capacity migration or 90-second timeout change.

The local.5 notes below are historical.

# Percentage capacity candidate (local.5, 2026-10-12)

New installations use 10% recent verbatim content, 4% summary output and 1% format-repair output, measured against each request's actual model window. Model/selection limits and protocol caps (128000/32768/8192 tokens) still apply. Rounding is downward; summary or repair allowances below 256 tokens stop the corresponding call. Unknown windows remain unknown.

Existing settings retain exact legacy token limits until an explicit percentage switch and native save. Larger model windows can increase allowances. `migrateCapacity` proposes a conservative conversion for one known window only and refuses unsupported conversions. Preserve revisions, unrelated settings, accounting and recovery permissions; do not silently change legacy fixed timeouts.

Current capacity and admission use window percentages. Historical pressure points use their own windows. Compaction comparisons use the replaced segment before=100%, not the whole window. Usage, costs and request input/output retain tokens. No accounting backfill or schema migration is performed.

Historical local.5 recovery note: this candidate was recovered from published commit 55fa6718f8f1d3abfc81daddbc248ee53a734377 after the original development tree disappeared. Its rebuilt verification is recorded in verification/context-percent-20261012/READY.md. This does not describe the current local.10 compatibility candidate.

# Missher DSH Context Manager

[中文](./README.md) | English

[Desktop](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [Downloads and releases](https://github.com/Missher12/Missher-DSH-Context-Manager/releases) · [Issues](https://github.com/Missher12/Missher-DSH-Context-Manager/issues)

Inspect per-session context composition, usage, compaction records and summary sources in DeepSeek Harness, and compact history before model requests when the configured threshold is reached. Optional idle compaction starts after a task completes normally and requires the host capability described below.

Package: `@missher/dsh-context-manager`. Candidate version: **0.10.0-local.16**. This is a Cordis Bundle, not a Codex or Claude Code implementation. This candidate is not published and cannot be installed from a Release asset.

The plugin now owns the final cancellation check and synchronous Session transaction. It no longer requires the added Basic capability marker or storage drain API. A private `.context-manager-recovery` directory under the active profile durably records pending usage/idle metadata before Host writes; restart reconciles the same attempt IDs without issuing model calls. It contains no conversation bodies. Conflicts or uncertain ownership fail closed. Usage never delivered before process exit stays unknown. Install the frozen tarball linked in [PUBLICATION.md](./PUBLICATION.md); this public repository includes its matching runtime files. This change does not alter Goal limits or MSE quotas.

## Historical: 0.10.0-local.4 recovery after an exhausted automatic allowance

The context panel separates a request that never dispatched from unknown usage of an earlier call. It records the deadline and stop reason used by each attempt. Increasing a timeout does not erase past usage or refund the automatic limit of two primary and four total calls per original cycle.

When that allowance is exhausted, run the manual rescue preflight, review the model, input estimate, deadline and unknown-cost warning, then explicitly confirm whether to continue. Each original cycle permits at most one additional manual summary call across restarts, without retries, repair or replaying an ended turn. Source, model, tool or policy changes invalidate confirmation, as does a two-minute expiry.

Preflight makes no model call, trims no original content and consumes no allowance. A cold session uses normal Host loading, which can append one initialization metadata event; every existing event is preserved, and preflight on a loaded session adds no events. Unfinished local summary transport, hot replacement or unverified installation metadata blocks rescue. Quit normally and reopen before checking again. Confirmation must still account for unknown prior provider cost.

This historical release preserved the timeout choices then in use. See [publication notes](./PUBLICATION.md) for its scope. Backups and downgrades must retain sessions, old accounting and the `context_manager_emergency` domain; deleting records must not replenish an allowance. Historical download: [v0.10.0-local.4 Release](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v0.10.0-local.4). This old link is not an installation path for local.15.

## Wait while long compaction makes progress

New installations use adaptive timing: a 600-second hard transaction limit, 120 seconds for the first meaningful output, and a 180-second stall limit. A progressing summary can exceed the old 90-second limit; a successful commit resumes the same native AgentLoop turn without replaying a completed tool.

**Existing settings are not automatically migrated to adaptive.** If `summaryTimeoutMode` is absent, old settings are read as fixed and the saved timeout remains. Adaptive timing applies only after explicitly switching to progress-based waiting and saving. Cancellation, hard deadlines and unknown-call accounting protections remain; an already ended failed turn is not revived.

Local.13 has no Release download asset yet; the preceding behavior description is historical, not an installation instruction for this candidate.

### Compact context view

The actual model follows the current-context heading. Session occupancy, composition, trends, compaction and content counts use K/M Tokens; percentages supplement shares, cache hits and savings. Unknown values remain unknown and partial totals remain lower bounds. Two compaction records and three content previews appear by default. Run details are collapsed and show six common facts; full diagnostics require an explicit copy action.

## Tool-result reduction, original archive and usage attribution

Tool-result reduction is limited to plain-text output from a foreground Bash command whose success is proven; failures, cancellation, timeouts, signals, non-empty stderr, upstream truncation, other tools and unknown result shapes pass through unchanged. The default **observe** mode measures without touching a Host result. In **Safe reduce** mode (`toolResultsMode=reduce`), the plugin first stores the original in a read-only archive under the profile, then publishes the short text, and counts the reference as confirmed only when the Host's final result still carries it. Pending, reverted and confirmed references are shown separately; a character delta is a visible-text difference, never a token bill or a real saving. The input cap and the minimum saving in characters are settings; results above the cap or below the minimum saving stay verbatim.

The archive and its outcome rows are durable: `.context-manager-archive` lives in the profile directory, survives restarts, rebuilds confirmed/pending/reverted state from those rows and reconciles physical quota. The default **original-blob quota is 512 MiB**: it counts the recorded bytes of stored originals, including rows left behind by an interrupted or orphaned write and rows that no reference points at any more. Exhausting it disables new reduction and never deletes an existing original. The root manifest is excluded from that total, and each of the three JSONL manifests has its own bound (64 MiB and a row cap). So 512 MiB is not a directory total or a whole-archive quota. Cross-call dedup means one stored original can carry several references, so a reference is identified by original id plus call id. Every archive read path is read-only: neither the panel's session readout nor a status read creates the archive, writes a file or appends a session event.

Compacted or reduced originals remain reachable through `context_history_search` and `context_history_read`, bounded, paginated and position-accurate. The per-read budget and search result limit are settings and stay subject to each tool's own output limit. A forked session reads back only the originals its inherited prefix was actually granted, with declared limits on boundary, reference count, scanned events and total log size; anything beyond those limits is reported as incomplete instead of being passed off as coverage.

The cumulative card shows business usage from the Host projection, summary-call usage (including any historical repair usage still in the ledger), and attempts with no usage report. The current local structure normalization makes no model call and creates no new repair-token usage. The Host's four buckets (uncached input, cache read, cache write, output) are mutually exclusive and are never added twice. When only some components were reported the figure is a **known lower bound** with its unknowns marked, and an all-unknown cut shows unknown rather than zero. The existing ledger has no durable purpose field, so summary and repair stay one undivided figure and cache-hit ratio uses only samples that reported every input component. Request-prefix diagnostics can be switched off without deleting any usage number.

A historical cut shows only attribution that has an event-log source: today's Host projection, ledger and archive results are never presented as old values, and quantities without a historical source read as unavailable for that cut.

## local.9 common recovery fix

One package serves all platforms. Windows keeps mandatory regular-file flushes and flushes the published file through a writable handle after atomic replacement; POSIX retains directory fsync. Flush/rename failures remain fatal and uncertain post-rename state refuses further writes until reopen. Windows permissions inherit the profile ACL; POSIX mode bits are not an ACL or sudden-power-loss guarantee. Native filesystem checks do not imply full Desktop or user-session acceptance.

Summary failures retain their native error type so the Host's existing image-offload hook can recognize an explicit image limit. Unknown errors do not gain automatic retries, and every physical summary call retains separate accounting.

## Historical local.9 working-set behavior

The older local.9 default used a 20K recent-history budget and an 8,192-token summary cap. Those values are historical, not local.15 new-install defaults. See the current settings table below.

Durable per-session source cycles allow at most two main summary plans and four total calls across steps/restarts; sufficient new original content is required to renew a cycle. Identical automatic requests cannot replay. Explicit manual retries still have a four-call transaction ceiling. The format normalization is local and value-preserving for a proven single-string array-field error; it does not make another model call. Permits are separate from actual per-call usage accounting.

Optional `context_history_read` / `context_history_search` tools retrieve original text from the executing session only, with exact positions and bounded pagination. No vector or external service is used. Each search covers at most 200 events / 32,768 characters and each JSON result is at most 8,000 characters; non-text data and uncovered ranges are explicit.

The native panel uses current TokenMeter admission when available; historical/unloaded/unknown reservation states stay unknown. Trends retain their estimated semantics. Structural validity is not a semantic-fidelity guarantee; real-model acceptance is recorded separately.

### local.2 session log integrity fix

Tool-result pruning now requires an open turn in the session log. Manual and idle maintenance skip this step while retaining valid checkpoint summaries, preventing out-of-turn tool replacements that strict V4 reload rejects. Protected pruning within a running turn is preserved. This prevents new invalid events; existing damaged logs require a separate backup-based recovery assessment and are not automatically rewritten.

## Host and platform requirements

Compatibility depends on real API capabilities and per-Agent bindings. Declared peer ranges permit investigated versions; they do not certify every Host in the interval.

| Environment / capability | Verified behavior and boundary |
| --- | --- |
| Frozen official RC.2 Loader source | Offline Loader plus synthetic adapter checked default Basic retention, Context request/idle sidecars and Basic's native overflow recovery; this is not real-provider, billing or natural desktop acceptance |
| Host compaction API v1 | Registers the enhanced Context provider only when the complete capability exists; otherwise the Host-declared provider remains and status follows each Agent's actual binding |
| Native Basic sidecar | Can expose a separate Context side path on an actual Basic binding; Basic's thresholds, overflow, retries and usage remain outside Context limits |
| Provider overflow | The plugin handles only its own `REBUILD` request error; provider `CONTEXT_WINDOW_EXCEEDED` is passed to the Host/Basic path |
| Missing `requestErrorHandoff` | A cancelled summary leaves new input queued and reports the limitation; no handoff is fabricated |
| alpha.2 and other Hosts, upgrades, Windows/Linux/Apple Silicon | The package peer range is not runtime acceptance; this round did not complete these natural Host, native platform or upgrade checks |

A version label alone is not a compatibility guarantee. The neutral overlay does not rewrite presets. Public screenshots, natural Host, upgrade, native UI and real-model acceptance remain pending.

## Install and update

Local.16 is a local package candidate, not a formal Release asset, and has not been installed on a daily device. Git sync, formal publication, anonymous-download checks, installation and Host-native readback must be recorded by their respective owners before the status changes. Do not replace this candidate with local.14 or an older package.

## Inspector and settings

One continuous panel uses native DSH controls and theme tokens:

- **Current context:** current occupancy, model window and composition labels use K/M Tokens, with percentages for shares, cache hits and savings; when the window is unknown, counts remain visible and ratios remain unknown. Capacity settings use percentages only in Settings, calculated against the actual model window. The Context reserve appears for an Agent bound to the enhanced Context provider, or for native Basic only while its Context sidecar is active. Other states do not show the sidecar reserve. Basic remains responsible for its own threshold, overflow recovery and usage accounting.
- **Changes and usage:** trends, before/after compaction, session totals and content rows use K/M Tokens, with ratios as supporting values. Summary calls have their own usage ledger. Run details are collapsed by default and show six common facts; full diagnostics require an explicit copy action. Missing measurements remain unknown; cumulative tokens are neither current occupancy nor a bill, a partially reported total is marked as a known lower bound, and an all-unknown total reads as unknown.
- **Effective content:** initially three rows and two recent compaction records, with expansion and pagination. Summary sources follow stored references. Text pages contain up to 16,000 characters; images show references. The inspector does not preload every historical body.

The view does not activate an Agent, call a model or append session events. It hides only its conversation's composer and restores the draft when returning to the conversation. It does not poll full history or text bodies; only lightweight idle status refreshes while open. Analysis is bounded at 50,000 log events and reports an error beyond that limit. Host layout-marker changes require renewed validation of composer handling.

Edit parameters only in **Settings → Context Manager** and save. Updating the package does not overwrite saved values.

New installations default to `capacityMode=percent` and `summaryTimeoutMode=adaptive`. Existing settings are not automatically migrated: when the mode fields are absent, they are read as legacy capacity and fixed timeout. Saved Token and fixed-timeout values remain available; percentage capacity and adaptive timing apply to an existing configuration only after the user explicitly switches modes and saves.

| Setting | Default |
| --- | --- |
| Automatic compaction master switch | Enabled |
| Capacity mode / trigger / retention | percent / 80% / automatic working set |
| New-install recent text / summary output | 10% / 4% of the actual model window |
| Saved custom occupancy cap (inactive by default) | 55% |
| Early check / safety space | 1% / 2% |
| Protocol caps in percentage mode | 128,000 recent / 32,768 summary tokens, also bounded by the model and request |
| Maximum compactions / adaptive timing | 2 / 600 seconds total, 120 first output, 180 stall |
| Idle compaction / idle delay | Enabled / 15 minutes |
| Minimum idle occupancy | Automatic: 65%; custom: max(65%, target + 10%); both capped by effective admission |
| Absolute working-history budget | Disabled; initial values 200,000 → 100,000 tokens |
| Local structure normalization | Enabled; value-preserving for a proven single-string array-field error; no model call |
| Saved legacy fields | `recentTokens=20,000`, `summaryMaxTokens=8,192`, `timeoutMs=90,000`, `formatRepairMaxTokens=2,048` remain for legacy/fixed reads; they are not auto-migrated to current defaults, and local normalization does not spend a repair allowance |
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
- Use the Host plugin manager to enable, disable or uninstall the whole Bundle, then restart as directed. Restore any Basic compactor references in custom presets that you changed; do not split the Bundle configuration by hand.
- There is no uninstall cleanup hook. Session logs retain original events, committed summaries and source references; this plugin does not actively delete them on uninstall. Completed compactions are not automatically reversed. Original content remains accessible through host queries or this inspector. **Referenced originals are retained the same way:** this version ships no cleanup action, retention switch or automatic deletion, and uninstalling does not remove the archive directory; back it up or handle it manually if you need to.
- The original archive stores only the text that a reduction referenced, under the profile's `.context-manager-archive`. A failed or over-quota write refuses publication instead of changing only memory. The archive holds no network copy beyond the conversation and uses no vector or external retrieval service. The default 512 MiB bounds the physical size of original blobs only; the metadata manifests have their own byte and row limits, so the directory total is not promised to be 512 MiB.
- Host `storageDomain` stores `context_manager_idle` for idle qualifications/status and `context_manager_summaries` for summary-call status/reported usage, and `context_manager_cycles` for request hashes, original-source watermarks and durable call permits. Failed summary raw output is not persisted; successfully committed output and references are in session logs. Unknown usage is not zero.
- Back up the target profile, plugin storage domains and session directory when upgrading or rolling back, not just the `.tgz`. No session migration is added by these metadata domains. The plugin does not maintain MSE long-term learning data or add a separate analytics endpoint. Summary input is sent through the host to the selected provider; host telemetry follows host settings.

## Validation and limitations

Local.16 inherits the Settings, Context and Run details UI updates and applies the native Input styling fix. The 12/12 targeted behavior tests are inherited local.15 evidence and were not rerun; Desktop still owns real RC.2 Input acceptance.

Historical evidence from 2026-10-03 (not local.13) includes 115 passing tests using real AgentLoop/JSONL/storage with a mock model, then 20 focused tests after a naming-only revision. Isolated custom rc.2 Loader/RPC and controlled Web validation covered light/dark themes, 1280/800/335px, source pagination, hidden composer and equal-height cards. A later Intel macOS daily installation confirmed the entries and read-only RPC for that older version; this does not establish current local.13 acceptance or installation.

Historical r3/older-package validation (not local.16): affected-source checks passed 88 cases with one environment skip. That older environment's Electron Node24 passed 115 of 116 key cases; the skipped ASAR-path case had a separate 3/3 Electron check. Host settings saves, restart, cold and loaded preflight, original events and old accounting were verified without real model requests for that earlier package. These are historical results, not new local.16 source, Host or installation acceptance. Native visuals, real-provider quality and remote machines remain unverified; overlapping groups are not additive. See [PUBLICATION.md](./PUBLICATION.md).

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

## Historical pre-local.13 timeout and retry note (superseded; not current local.13 policy)

**The entire appendix below is retained as version history only.** Its statements that adaptive timing is opt-in and that automatic/manual/recovery calls share a 2-primary/4-total budget describe older behavior; do not apply them to local.13. Current local.16 policy is documented in the sections above: new installations default to adaptive timing (600 seconds total, 120 seconds to first meaningful output, 180 seconds stalled); existing configurations with no mode field remain fixed until explicitly switched and saved. Current manual and recovery budgets follow the local.16 ledger and policy. Native Basic retains its own accounting; Context call limits and ledger cover only the separate Context sidecar path.

Existing configurations keep fixed mode and their exact transaction-wide `timeoutMs`. Adaptive mode is opt-in: 600 seconds total, 120 seconds to first nonempty text/reasoning, and 180 seconds stalled by default. Repairs share the remaining total. Usage/heartbeat/empty chunks never renew progress.

Durable permits bind each provider attempt to its ledger and compaction. Ordinary automatic, manual and recovery calls share a 2-primary/4-total source budget. After exhaustion, the separate explicitly confirmed rescue permits only one additional call per cycle, without retries or repair. Unknown outcomes never automatically replay. The context panel offers an explicit, expiring, exact-source/route recovery mutation when budget is provable; unbound legacy manual charges require verification. Busy idle plans retain eligibility with capped backoff.

Back up context_manager_operations with cycles/idle/summaries and the recovery journal. Older versions cannot enforce the new permit table: disable automatic compaction before a coordinated downgrade; keep current sessions and accounting. Exact evidence and limitations are in [PUBLICATION.md](./PUBLICATION.md). Earlier local.1 results are historical.
