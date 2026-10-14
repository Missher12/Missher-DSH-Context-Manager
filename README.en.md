# Context Manager

[中文](README.md) · [Desktop and all plugins](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [Regular downloads](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/latest)

Compacts oversized context before model requests, retains traceable original text, and distinguishes current occupancy, summary usage and recovery state. Package: `@missher/dsh-context-manager`. The source and matching runtime files are **0.10.0-local.9**.

[The local.9 formal release](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v0.10.0-local.9) is published. The paired Ubuntu desktop installation, native settings and Context view were verified, with all three plugin entries active and existing sessions and settings preserved. See [delivery notes](PUBLICATION.md) and the [public package manifest](RELEASE-MANIFEST.json) for exact artifacts, required capabilities and evidence limits.

## Choose a package for your Host

| Package | Required Host capabilities | Difference |
| --- | --- | --- |
| `0.10.0-local.9` | Matching Host with `preset-compaction-provider-patch-v1`; new-input continuation also requires the paired AgentLoop request-error handoff fix | Replaces only the compaction provider, retaining the rest of the Host preset |
| `0.10.0-local.9-legacy.1` | The verified complete Standard/PTC/Cordis presets and existing services | Full-preset override fallback; lacks the new-input continuation capability and needs renewed comparison when Host presets change |

Official `0.2.1-alpha.2` packages do not contain the new interface. This version is a tested baseline, not proof that every Host with that label includes the patch, nor the only usable version. Maintenance targets reasonable version ranges and continued adaptation to the latest release. Required services, capabilities and actual evidence determine compatibility; untested ranges are not claimed as passing. These are alternative builds of one plugin: install one, with no additional compatibility plugin.

Required services include Session, Projection, TokenMeter, StorageDomain, BasicCompactionEngine, Remote, settings and shared UI services. [COMPATIBILITY.json](COMPATIBILITY.json) retains build-time metadata; its internal evidence paths are not public downloads. Public checksums and capability requirements are in the delivery notes.

## Features

- Strict checkpoint validation; only a proven single string in an array field is wrapped without changing its value or calling a model. Other invalid structures are rejected and originals retained.
- Full-request feasibility checks account for working-set growth and continuation headroom, both before dispatch and before committing a summary.
- Distinct not-dispatched, dispatched, physical-completion, candidate and committed states. `not_dispatched` is not unknown usage; incomplete usage from dispatched work stays unknown and is never automatically replayed for a charge.
- Opt-in `context-manager/3` sections format; JSON remains the default. Structural validity does not prove semantic fidelity.
- Bounded reduction of successful foreground Bash plain text: nonempty cwd, exit code zero, no cancellation/timeout/signal, untruncated stdout/stderr and empty stderr are required. Only identical repeated lines are folded. Originals are archived first; publication is recorded only if the final Host result retains the reference. Default `observe` requires explicit `reduce` selection to rewrite text. Other tools, failures and incomplete results are retained; there is no vector store or promised cost saving.
- Same-session `context_history_search` / `context_history_read` page original text and source positions within fixed scan/output limits, without accessing another session or writing to MSE.

## Install and update

Choose a `.tgz` from a regular Release that meets the Host capabilities above, verify its SHA-256, and install through DSH plugin management. The main package was verified on the paired Desktop `0.2.1-alpha.2.20261014.1`; other versions are assessed by capabilities and evidence. Desktop installers and plugins are separate downloads. Downloading source or updating only the desktop does not automatically replace installed user plugins.

Back up the full profile, sessions, original archive and accounting before updating. Finish active work, then exit and restart normally. Check all three entries—`context-manager`, `context-manager-engine`, `context-manager-inspector`—and the conversation Context view and saved settings. Updating does not replace saved values with defaults.

## Inspector and settings

One continuous panel uses native DSH controls and theme tokens:

- **Current context:** the model window, occupied content, unoccupied space and gray striped compaction reserve. Summaries, tools, messages and instructions have separate estimated token counts; unmatched host measurements appear as other usage. Reserve is derived from the current admission threshold, not permanently unusable capacity.
- **Changes and usage:** occupancy bars, before/after compaction, cumulative session tokens and cache hits. Summary calls have their own usage ledger, and compact attribution and tool-reduction status lines were added (details stay collapsed by default). Missing measurements remain unknown; cumulative tokens are neither current occupancy nor a bill, a partially reported total is marked as a known lower bound, and an all-unknown total reads as unknown.
- **Effective content:** three preview rows and two recent compaction records when collapsed; expanded content is shown in batches of four, with further expansion and pagination. Summary sources follow stored references. Text pages contain up to 16,000 characters; images show references. The inspector does not preload every historical body.

The view does not activate an Agent, call a model or append session events. It hides only its conversation's composer and restores the draft when returning to the conversation. It does not poll full history or text bodies; only lightweight idle status refreshes while open. Analysis is bounded at 50,000 log events and reports an error beyond that limit. Host layout-marker changes require renewed validation of composer handling.

Edit parameters only in **Settings → Context Manager** and save. Updating the package does not overwrite saved values.

| Setting | Default |
| --- | --- |
| Automatic compaction master switch | Enabled |
| Trigger / retention mode | 80% / automatic working set |
| Recent text preference | 20K tokens |
| Saved custom occupancy cap (inactive by default) | 55% |
| Early check / safety space | 1% / 2% |
| Summary output limit | 8192 tokens, also bounded by the actual model and request |
| Maximum compactions per request | 2 |
| New-install timing mode | Adaptive: 600 seconds total, 120 seconds to first meaningful output, 180 seconds stalled |
| Fixed-mode whole-transaction limit | 90 seconds by default; saved modes and values are preserved |
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

Idle timing starts at **normal task completion**, with bounded postponement for background work. New input, a model change, stop or disable invalidates an old plan. Each completion qualification can start at most one idle summary, durably recorded before the request. Restart restores only unattempted qualifications for registered sessions that are loaded again, with at least five seconds before rechecking. Requests with unknown outcomes are not blindly billed again. If new input cancels pre-request compaction, the Host queue retains it. The paired Host request-error handoff provides automatic continuation for the verified cases; the legacy path lacks this capability and must follow the stop reason. Nothing runs while the app is closed, and old sessions are not all scanned or activated.

Built-in official DeepSeek routes also show peak/off-peak periods and a cost comparison; third-party routes hide it. This uses the plugin's **2026-09-29 pricing-policy and 2026 calendar snapshot**, not a live price feed. Unknown models or years are not invented. Actual charges follow [DeepSeek's pricing documentation](https://api-docs.deepseek.com/quick_start/pricing/) and the provider bill.

## Summary deadlines and bounded recovery

New installations use adaptive timing: 600 seconds for the whole transaction, 120 seconds for first meaningful output, and 180 seconds without further output. Only nonempty text or reasoning deltas renew progress; format repair shares the remaining total deadline. Existing policies without a mode retain fixed timing, their saved `timeoutMs` and its whole-transaction limit. Updating never silently replaces a saved choice.

The same original source can claim at most two primary summary plans and four actual model calls across steps and restarts, including ordinary manual retries. Only sufficient new original input starts a new cycle. Increasing the timeout does not replenish spent permits. A request that never dispatched is not unknown usage; dispatched requests with unknown outcomes or usage are not automatically replayed for another charge.

After the automatic allowance is exhausted, run manual rescue preflight in the context panel and explicitly confirm one additional call. Each original cycle permits at most one rescue, with no retry or format repair. Confirmation is bound to the exact source, model, tools and policy, and expires after two minutes. Preflight makes no model call, trims no original content and spends no summary allowance. Normal Host loading of a cold session can add one initialization metadata event. Unfinished prior transport, hot replacement or unverified installation metadata blocks rescue; exit normally and reopen before checking again. Prior unknown provider cost must remain unknown, not zero.

Backups must retain `context_manager_operations`, `context_manager_emergency`, existing cycles/idle/summaries domains, recovery journals and current sessions. Older versions do not understand the new permit domains. Disable automatic compaction before a coordinated rollback and preserve all records; deleting records or only downgrading the program must not replenish paid-call allowances.

## Disable, uninstall and data

- Turning off automatic compaction stops both request-time and idle automatic compaction; the hard context-window guard remains. Turning off only idle compaction keeps request-time compaction enabled. The inspector and the host's manual `/compact` command remain available.
- Disable the whole Bundle in plugin management and restart as directed by the host. Use the same manager to uninstall after active tasks finish. For CLI/Web, use `dsh plugin --profile my-context remove @missher/dsh-context-manager`.
- Removing or disabling the Bundle's overlay and restarting lets the host recreate its original presets and compactor. Restore Basic compactor references in any custom presets you edited before uninstalling. Do not remove only one of the three internal entries.
- There is no uninstall cleanup hook. Session logs retain original events, committed summaries and source references; this plugin does not actively delete them on uninstall. Completed compactions are not automatically reversed. Original content remains accessible through host queries or this inspector. **Referenced originals are retained the same way:** this version ships no cleanup action, retention switch or automatic deletion, and uninstalling does not remove the archive directory; back it up or handle it manually if you need to.
- The original archive stores only the text that a reduction referenced, under the profile's `.context-manager-archive`. A failed or over-quota write refuses publication instead of changing only memory. The archive holds no network copy beyond the conversation and uses no vector or external retrieval service. The default 512 MiB bounds the physical size of original blobs only; the metadata manifests have their own byte and row limits, so the directory total is not promised to be 512 MiB.
- The profile-local `.context-manager-recovery` directory records pending usage and idle metadata, never conversation bodies. Restart reconciles the same attempt IDs without model replay. Conflicting, damaged or ambiguously owned records fail closed. Usage never received before process exit remains unknown.
- Host `storageDomain` stores `context_manager_idle` for idle qualifications/status and `context_manager_summaries` for summary-call status/reported usage, and `context_manager_cycles` for request hashes, original-source watermarks and durable call permits. Failed summary raw output is not persisted; successfully committed output and references are in session logs. Unknown usage is not zero.
- Back up the target profile, plugin storage domains and session directory when upgrading or rolling back, not just the `.tgz`. No session migration is added by these metadata domains. The plugin does not maintain MSE long-term learning data or add a separate analytics endpoint. Summary input is sent through the host to the selected provider; host telemetry follows host settings.

## Validation and limitations

The narrow build passed 392/396 tests with 4 skips; legacy passed 389/396 with 7 skips; paired Host regression passed 56/56. [Delivery notes](PUBLICATION.md) list every skip, type checks and independent recovery checks. These isolated and synthetic checks do not establish real-model summary fidelity, daily installation or native behavior on every platform.

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
