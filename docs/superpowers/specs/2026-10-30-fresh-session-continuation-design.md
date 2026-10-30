# Fresh-Session Continuation for pi — retrieval instead of compaction

**Status**: design awaiting approval · **Date**: 2026-10-30 · **Target**: pi extension (pi ≥ 1.4.0)

## Intent

Replace pi's automatic LLM-summary compaction with retrieval continuation. When the context fills up, the agent continues — **automatically, with no summarization call and no paraphrase** — in a fresh session that retrieves the exact lines it needs from the full record of the old session.

Why: compaction today spends a full-context LLM call (measured elsewhere: 29–38 s, $0.17–1.99 on a ~400k session) and its summary is lossy — the exact error message, file path, or number is often gone. Pi already persists the full record in the session JSONL; the summary step adds cost and destroys fidelity for no benefit when the agent can search the record itself.

## Goals

1. **Fully automatic** at the same trigger points as today's compaction (threshold between turns, pre-prompt check, overflow recovery). Zero user action.
2. **Fresh session file**, created in-process; the interrupted task continues with no user involvement.
3. **Zero LLM summarization** anywhere in the flow. The switch itself costs ~0 s / $0. The only new spend is on-demand recall calls.
4. **Lossless**: every token moved out of context stays reachable verbatim via a recall tool.
5. **Self-healing degradation where pi supports it**: if the switch is cancelled (`session_before_switch`) or the deferred dispatch never executes, the session continues losslessly in place on pointer + recall context. A throw inside `ctx.newSession` *after teardown begins* is fatal to the process (pi's TUI wrapper exits on command-context errors); the guarantee there is limited to: the old session file remains intact and resumable. Pre-flight validation minimizes the chance of reaching that path.
6. **Exception (explicit)**: in-memory sessions (`--no-session`) have no record to retrieve from; there the extension falls through to pi's default LLM compaction and notifies once. Goals 3–4 hold for persisted sessions, which is the only mode where they are meaningful.

## Non-goals

- No summaries, embeddings, vector indexes, or curated "memory". The model gets the raw record plus tools (the bitter-lesson stance).
- No cross-project knowledge base. `recall` targets only the current session's file and its `parentSession` ancestor chain — no arbitrary-path search.
- No pi-core changes. Extension only.
- Branch summarization (`/tree`, `session_before_tree`) keeps pi's default behavior; out of scope for v1.
- Auto-switch in print mode is out of scope (pointer compaction only); session switching is exercised in TUI and RPC modes.

## Anti-goals

- An LLM call at the threshold moment — that is the thing we are deleting.
- Any path where the agent overflows with no recovery (dead run).
- A paraphrase presented as context.

## Constraints (verified against pi 1.4.0 source)

- `session_before_compact` can return custom compaction content; the returned `firstKeptEntryId` passes verbatim to `appendCompaction`, where `firstKeptEntryId ?? id` yields a **retain-none** compaction (`agent-session.js` ~2253/2543, `session-manager.js:890`). The TypeScript type says `string`; runtime accepts `undefined` (needs a cast).
- Session replacement (`ctx.newSession`) exists only on `ExtensionCommandContext`; lifecycle handlers must not call it directly (deadlock rule). Escape hatch: `pi.sendUserMessage("/fresh", { expandPromptTemplates: true })` — `prompt()` dispatches extension commands **immediately, even during streaming**, before the streaming-queue check (`agent-session.js:1626–1646`).
- The dispatch must be **deferred one tick** (`setImmediate`) from inside the compaction hook, so the command runs on the normal command path after the hook returns, not re-entrantly inside its dispatch stack.
- **Trigger timing** (drives the switch semantics below): the threshold check fires between turns (after tool results, before the next LLM call) and after `agent_end` at run boundaries; the pre-prompt check fires at the start of `_prepareRun` — **before the triggering prompt is appended to the session** (`agent-session.js:1480–1486`); overflow recovery fires after the failed run, with the retry pending.
- `newSession` handles an active run: `teardownCurrent` awaits `session.abort()`, so the in-flight turn (including tool results) persists to the outgoing session before replacement (`agent-session-runtime.js:102–110`). `session.abort()` does **not** restore queued steering input to the editor (that TUI path is not invoked), and in-memory queues (`_steeringMessages`/`_followUpMessages`) are dropped at dispose — hence the pending-message guard below.
- `withSession` receives a `ReplacedSessionContext` exposing `sendUserMessage`, which **awaits the entire first turn** of the fresh session (`agent-session.js:1910–1939`): `newSession`, the `/fresh` handler, and the outer dispatch chain stay pending for the length of that run.
- The TUI wraps command-context session operations in error handling that escalates a throw to a fatal runtime error and process exit (`interactive-mode.js:1484–1491, 1609–1623`).
- `preparation.fileOps` is available only inside the hook; the extraction helpers are not exported by the package, so `/fresh` cannot recompute file lists — the hook must hand them over.
- Fresh session headers carry `parentSession` — `recall` finds its default targets mechanically, with no cross-runtime state.
- In-memory sessions (`--no-session`) have no file to recall from: fall through to default compaction.

## Approaches

1. **Manual `/fresh` only** — works, dead simple, but the user wants it as automatic as compaction is today. Rejected.
2. **Same-session retain-none pointer compaction only** — automatic everywhere, zero risk, but not a fresh session file; the user said the fresh session is key. Rejected as primary; retained as the fallback flavor (safety net).
3. **Auto-switch at threshold with a pointer-compaction safety net** — chosen. The hook writes a retain-none pointer compaction (static text, no LLM call), then defers a self-invoked `/fresh` command by one tick. Happy path: fresh session file, task continues there. Failed switch: in-place pointer continuation, task continues anyway. The purist variant (`cancel: true`, no safety net) was rejected: if the deferred switch ever fails, the run continues on a full context, overflows the provider, and a cancelled recovery leaves it dead mid-task. A review pass refined two details: `/fresh` waits for idle when messages are queued (no in-flight drops, ever), and manual `/compact` keeps pi's recent-tail cut rather than going retain-none (see below).

## How (decided)

### Threshold and overflow flow (`reason: "threshold" | "overflow"`)

1. Hook `session_before_compact` fires. If the session is not persisted → return `undefined` (default LLM compaction; nothing to recall) and notify once.
2. Build the pointer text (below). Return `{ compaction: { summary: pointerText, firstKeptEntryId: undefined, tokensBefore } }` → retain-none entry, zero LLM cost. **This is the safety net**: context immediately becomes `[system][pointer]`.
3. Persist the **switch payload** in extension runtime state: `{ oldSessionPath, readFiles, modifiedFiles }` (the parts only the hook can compute), and set a **switch-pending** flag.
4. `setImmediate(() => pi.sendUserMessage("/fresh", { expandPromptTemplates: true }))`, guarded against double-queuing per threshold event. The promise is unobserved by design (the API returns void); detection of a failed dispatch is the switch-pending flag, not a rejected promise.
5. `/fresh` executes on the normal command path (details below), consuming the payload. It captures the **last user message, its images, and the TOC from the persisted branch at execution time** — one tick after the trigger, so the pre-prompt case sees the triggering prompt once it is appended. The spike must confirm this ordering; if the newest message is not yet on the branch when `/fresh` runs, re-read with a bounded wait rather than proceeding with a stale payload.

### `/fresh` command (auto-invoked at threshold; manually invocable)

1. Clear the switch-pending flag (the dispatch landed).
2. **Pending-message guard**: if `ctx.hasPendingMessages()`, `await ctx.waitForIdle()` first, so queued input is delivered and persisted before the switch — nothing is dropped, ever.
3. **Pre-flight validation** before `newSession`: old session file readable, session dir writable, parent path resolvable. Any failure → notify and stay on pointer mode (the run is safe; no switch attempt). This keeps the fatal-after-teardown path (`session.abort()` → dispose → throw) as unlikely as it can be made from extension code.
4. Build the pointer prompt from the hook payload + the persisted branch tail.
5. `ctx.newSession({ parentSession: oldSessionPath, withSession: rc => rc.sendUserMessage(pointerPrompt) })`, wrapped in try/catch: on `{ cancelled: true }` or a throw *before* teardown, notify and stay on pointer mode. A throw after teardown is fatal to the process (Constraint); the old session file remains intact and resumable — that is the stated guarantee.
6. **Blocking semantics, decided**: the pointer prompt is sent *inside* `withSession` and awaited (`ReplacedSessionContext.sendUserMessage` awaits the first turn). The automatic chain is fire-and-forget from `setImmediate`, so nothing user-visible blocks. The known consequence: a **manual** `/fresh` submitted over RPC keeps that RPC request open for the duration of the fresh session's first turn — documented, acceptable. Print mode disables auto-switch entirely (non-goal above).

### Per-trigger switch timing

| Trigger | Hook fires | In-flight request when `/fresh` runs | Switch lands |
|---|---|---|---|
| Threshold, mid-run | between turns (after tool results, before next LLM call) | none, or the first small post-pointer call | immediately; `teardownCurrent` settles the turn |
| Threshold, run boundary | after `agent_end`, before the next run | none | immediately, already idle |
| Pre-prompt | start of `_prepareRun`, before the prompt is appended | the new run's first LLM call (small post-pointer input) | that call is aborted (cents); the triggering prompt is persisted and becomes the pointer's "last user message" |
| Overflow recovery | after the failed run, retry pending | the retried turn's first call | aborted; the pointer carries the task |

Waste is bounded to at most one small post-pointer request, only on the pre-prompt and overflow paths; the common threshold paths abort nothing.

### Manual `/compact` (`reason: "manual"`)

- Bare `/compact` → **pointer compaction that keeps pi's suggested `firstKeptEntryId`**: the recent tail stays exactly as pi's manual compaction keeps it, and the LLM summary call is replaced by the static pointer. Rationale: manual `/compact` means "shrink this session so I can keep going" — the recent tail is what the user continues from; retain-none would silently change that contract. The threshold path stays retain-none because the fresh session starts from the pointer alone. No auto-switch on manual compaction.
- `/compact <instructions>` → return `undefined` → default LLM compaction: the user explicitly asked for a focused summary; explicit intent wins.

### The pointer text (one generator, two call sites: compaction summary and `/fresh` prompt)

Mechanical, lossless, no LLM:

- absolute path of the old session file, and that the record is complete and verbatim;
- the **last user message verbatim** (captured at `/fresh` execution time), marked "you were mid-task; resume this"; for the `/fresh` prompt, re-attach that message's image blocks too (`sendUserMessage` accepts `ImageContent`) so multimodal tasks keep their inputs;
- a TOC: first line of every user message on the active branch, rebuilt from the branch plus ancestor files so it is **cumulative** (an index, not a summary; size-capped with a truncation marker);
- files read/modified, from the hook's `preparation.fileOps` (manual `/fresh` without a preceding hook omits this list — it cannot be recomputed);
- usage instruction: "Do not re-ask the user. When you need the exact error message, file path, number, or prior decision, search the record with `recall` instead of re-deriving.";
- **self-sufficiency**: "If the `recall` tool is not available (extension disabled), read the session file directly with the read/bash tools." — so a resumed pointer-only session still works under stock pi, where the only cost is that the model greps the JSONL itself.

### `recall` tool set (read-only)

- `recall` — search: `{ query: string (literal or regex), role?: user|assistant|toolResult, limit? }` → hits with file, entry id, role, timestamp, short excerpt. Targets, by construction: the current session's file and its `parentSession` ancestor chain (cap ~5 files). **No arbitrary-path parameter** in v1 — that was cut in review as an unexamined data-exposure surface (any session JSONL on disk, other projects, pasted secrets).
- `recall_get` — fetch verbatim: `{ entryId }` or `{ around: { entryId, before, after } }` → exact content (full tool results included), capped with a marker and a way to page.
- **Scan budgets** (both tools): max bytes scanned per call (~50 MB), max elapsed time (~10 s), max matches returned (~50); a truncated result says so and tells the model to narrow the query. Files can be hundreds of MB and the query is model-chosen — an unbounded scan can pin a turn.
- Implementation: stream the JSONL line-by-line; never load whole files; tolerate a partial trailing line (files are mid-append); search abandoned branches too (a feature: "what did I try before?").

### Degradation and edge cases

- **Switch cancelled or never dispatched** → the safety net already landed; the run continues in place, losslessly. The **switch-pending flag** detects the never-dispatched case: set at the hook, cleared when `/fresh` executes; if the next `agent_end` (same session file) still sees it set, emit the degraded notice and log the captured error. Cancellation (`session_before_switch`) is observed directly in `/fresh`'s result.
- **Throw after teardown** → fatal (Constraint); old session file intact and resumable; pre-flight makes this path unlikely.
- Overflow recovery (`willRetry: true`) → same flow; if the switch loses the race, the retried turn proceeds on pointer context.
- Double-threshold guard: never queue `/fresh` twice.
- Queued input: the pending-message guard delivers and persists it before any switch; no drops in the automatic path. A manual mid-stream `/fresh` also waits for idle — same guarantee.
- Images: `recall` returns text only (documented limit); the switch itself re-attaches the last user message's images.
- Resuming a pointer session with the extension disabled: the pointer text is self-sufficient (see pointer section); the full record remains reachable through `/tree` and the file system. The session picker shows pointer text until the session is named — acceptable; no auto-renaming in v1.
- RPC mode: the flow works headlessly; a manual `/fresh` holds its request open for the fresh first turn (documented above). Print mode: no auto-switch.

### TUI

- Notify on switch: "Context full → fresh session (previous session preserved: `<path>`)".
- Notify on degradation: "Switch to a fresh session did not land; continuing with recall on pointer context (`<error>`)".
- Entry renderer for the pointer compaction: a divider like "— context moved onward; use recall —".

## Success criteria (measured on the reference ~400k-token session)

- Switch latency, trigger → fresh session's first turn starts: **< 5 s**.
- Cost per continuation: **$0** for the switch itself; **< $0.10** total for the fresh first turn plus recall calls (vs. $0.17–1.99 for one compaction).
- Replay check: a scripted task interrupted at the threshold completes in the fresh session **without re-asking the user** — the pointer carries the task, recall finds the specifics.
- Disable-compatibility check: the same session resumed with the extension removed still continues the task from the pointer text alone.

## Staged delivery (each stage has an exit criterion; later stages depend on earlier)

0. **Spike, retained as an integration test**: deferred dispatch + retain-none + switch on a synthetic session. Exit: switch lands, no deadlock, aborted turn persisted, pointer prompt starts the fresh turn, pre-prompt ordering confirmed (triggering prompt on the branch when `/fresh` runs; blocking semantics of the awaited first turn observed).
1. **JSONL reader + `recall`/`recall_get`** with fixture-based tests (tree entries, abandoned branches, partial trailing line, budgets, caps). Exit: unit tests green, including the scan-budget truncation markers.
2. **Pointer generator** shared by both call sites, with the self-sufficiency line. Exit: golden-file tests for both outputs.
3. **`/fresh` switch path**: payload handoff, pending-message guard, pre-flight, cancellation and throw handling, degraded notices. Exit: manual `/fresh` works; a forced cancellation notifies and leaves pointer mode intact.
4. **Three triggers wired**: threshold (mid-run and boundary), pre-prompt, overflow; double-queue guard; switch-pending detection. Exit: per-trigger integration tests for all three reasons, plus the fallback-path test (switch cancelled → pointer mode).
5. **TUI**: renderer and notices; headless-mode test for RPC.
6. **Install layout + README** (cost table, `--no-session` and print-mode limits, disable-compatibility) and the success-criteria measurements.

## De-risking (folded into Stage 0's exit criteria)

1. Prove the deferred dispatch live — the one source-inferred mechanism.
2. Verify the race where `/fresh` executes while the auto-compaction abort controller is still set (extension commands bypass the prompt guard; confirm no conflict).
3. Confirm the runtime accepts `firstKeptEntryId: undefined` from the hook (types say `string`; cast if needed).

## What's left to the builder

Exact TypeBox schemas for `recall` / `recall_get`; the JSONL reader internals; result renderers; install layout (repo dir → `~/.pi/agent/extensions/`); the README's measured numbers filled in from the success-criteria runs.
