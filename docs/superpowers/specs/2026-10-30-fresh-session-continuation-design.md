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
5. **Self-healing degradation**: if the fresh-session switch cannot land, the session continues losslessly in place. Never a dead run, never a lossy summary.

## Non-goals

- No summaries, embeddings, vector indexes, or curated "memory". The model gets the raw record plus tools (the bitter-lesson stance).
- No cross-project knowledge base. `recall` reads session JSONL files only.
- No pi-core changes. Extension only.
- Branch summarization (`/tree`, `session_before_tree`) keeps pi's default behavior; out of scope for v1.

## Anti-goals

- An LLM call at the threshold moment — that is the thing we are deleting.
- Any path where the agent overflows with no recovery (dead run).
- A paraphrase presented as context.

## Constraints (verified against pi 1.4.0 source)

- `session_before_compact` can return custom compaction content; the returned `firstKeptEntryId` passes verbatim to `appendCompaction`, where `firstKeptEntryId ?? id` yields a **retain-none** compaction (`agent-session.js` ~2253/2543, `session-manager.js:890`). The TypeScript type says `string`; runtime accepts `undefined` (needs a cast).
- Session replacement (`ctx.newSession`) exists only on `ExtensionCommandContext`; lifecycle handlers must not call it directly (deadlock rule). Escape hatch: `pi.sendUserMessage("/fresh", { expandPromptTemplates: true })` — `prompt()` dispatches extension commands **immediately, even during streaming**, before the streaming-queue check (`agent-session.js:1626–1646`).
- The dispatch must be **deferred one tick** (`setImmediate`) from inside the compaction hook, so the command runs on the normal command path after the hook returns, not re-entrantly inside its dispatch stack.
- `newSession` handles an active run: `teardownCurrent` awaits `session.abort()`, so the in-flight turn (including tool results) persists to the outgoing session before replacement (`agent-session-runtime.js:102–110`). Mid-run switching is a designed-for path.
- `withSession` receives a `ReplacedSessionContext` exposing `sendUserMessage` — the pointer prompt can be auto-submitted as the fresh session's first message.
- Fresh session headers carry `parentSession` — `recall` can find its default target mechanically, with no cross-runtime state.
- In-memory sessions (`--no-session`) have no file to recall from: the extension must fall through to default compaction.

## Approaches

1. **Manual `/fresh` only** — works, dead simple, but the user wants it as automatic as compaction is today. Rejected.
2. **Same-session retain-none pointer compaction only** — automatic everywhere, zero risk, but not a fresh session file; the user said the fresh session is key. Rejected as primary; retained as the fallback flavor (see safety net).
3. **Auto-switch at threshold with a pointer-compaction safety net** — chosen. The hook writes a retain-none pointer compaction (static text, no LLM call), then defers a self-invoked `/fresh` command by one tick. Happy path: fresh session file, task continues there. Failed switch: in-place pointer continuation, task continues anyway. The purist variant (`cancel: true`, no safety net) was considered and rejected: if the deferred switch ever fails, the run continues on a full context, overflows the provider, and a cancelled recovery leaves it dead mid-task.

## How (decided)

### Threshold and overflow flow (`reason: "threshold" | "overflow"`)

1. Hook `session_before_compact` fires.
2. If the session is not persisted → return `undefined` (default LLM compaction; nothing to recall).
3. Build the pointer text (below). Return `{ compaction: { summary: pointerText, firstKeptEntryId: undefined, tokensBefore } }` → retain-none entry, zero LLM cost. **This is the safety net**: context immediately becomes `[system][pointer]`.
4. `setImmediate(() => pi.sendUserMessage("/fresh", { expandPromptTemplates: true }))`, guarded against double-queuing per threshold event.
5. `/fresh` command executes (immediately, even while streaming): capture the old session file path, last user message, and TOC as plain data; call `ctx.newSession({ parentSession, withSession: rc => rc.sendUserMessage(pointerPrompt) })`.
6. The pointer prompt is auto-submitted as the fresh session's first message → the first turn starts by itself; the agent recalls what it needs.

Switch timing (decided): the switch lands **mid-run** — the literal Mainplane moment, not at run end. The aborted in-flight request is the *first* request after the pointer landed, so its input is the tiny pointer context, not the old one; the waste is cents. The fresh session visibly continues the interrupted task, which is the product's point. At-run-end switching was rejected: it saves one partial request but leaves the fresh session with no task and delays the file boundary.

### Contract: pi's compaction trigger stays enabled

The extension replaces the **summarization LLM call**, not the trigger machinery. All three trigger points (threshold between turns, pre-prompt check, overflow recovery) live inside pi's compaction machinery; with `compaction.enabled: false` the hook never fires and a full context dead-ends. On `session_start`, if compaction is disabled, notify prominently that the extension requires the machinery enabled (the default). A private threshold watcher (`turn_end` + `getContextUsage()` + `ctx.compact()`) was rejected: a duplicate engine with its own race surface.

### Manual `/compact` (`reason: "manual"`)

- Bare `/compact` → pointer compaction (retain-none), no auto-switch: the user asked to compact *this* session.
- `/compact <instructions>` → return `undefined` → default LLM compaction: the user explicitly asked for a focused summary; explicit intent wins.

### The pointer text (one generator, two uses: compaction summary and `/fresh` prompt)

Mechanical, lossless, no LLM:

- absolute path of the old session file, and that the record is complete and verbatim;
- the **last user message verbatim**, marked "you were mid-task; resume this"; for the `/fresh` prompt, re-attach that message's image blocks too (`sendUserMessage` accepts `ImageContent`) so multimodal tasks keep their inputs;
- a TOC: first line of every user message on the active branch, rebuilt from the parent-chain files so it is **cumulative** (an index, not a summary; size-capped with a truncation marker);
- files read/modified, taken from `preparation.fileOps` (same mechanical extraction pi's compaction already uses);
- usage instruction: "Do not re-ask the user. When you need the exact error message, file path, number, or prior decision, search the record with `recall` instead of re-deriving."

### `recall` tool set (read-only)

- `recall` — search: `{ query: string (literal or regex), role?: user|assistant|toolResult, limit? }` → hits with file, entry id, role, timestamp, short excerpt. Default targets: this session's `parentSession`, then the current file, then ancestors transitively up the `parentSession` chain (cap ~5 files); explicit path overrides.
- `recall_get` — fetch verbatim: `{ entryId }` or `{ around: { entryId, before, after } }` → exact content (full tool results included), capped with a marker and a way to page.
- Implementation: stream the JSONL line-by-line; never load whole files; tolerate a partial trailing line (files are mid-append); search abandoned branches too (a feature: "what did I try before?"); cap result sizes like pi's `truncated-tool.ts` example.

### Degradation and edge cases

- Switch cancelled or failed (another extension cancels `session_before_switch`, a headless-mode quirk, a thrown command) → the safety net already landed; the run continues in place, losslessly. Notify which flavor took effect (guarded by `ctx.hasUI`).
- Overflow recovery (`willRetry: true`) → same flow; if the switch loses the race, the retried turn proceeds on pointer context.
- Double-threshold guard: never queue `/fresh` twice.
- Images: `recall` returns text only (documented limit); the switch itself re-attaches the last user message's images.
- Queued steering: in the threshold path, queued steering is delivered and persisted during `prepareNextTurn` before the deferred `/fresh` fires, so nothing is lost. A manual mid-stream `/fresh` can drop unconsumed queued input (the queue is in-memory and not publicly readable) — documented edge.
- RPC/JSON modes: `prompt()` dispatches commands headlessly; the flow works without a TUI.

### TUI

- Notify on switch: "Context full → fresh session (previous session preserved: `<path>`)".
- Entry renderer for the pointer compaction: a divider like "— context moved onward; use recall —".
- No auto-renaming of the old session in v1.

## De-risking (first steps of the plan)

1. **Spike (throwaway, step 0): prove the deferred dispatch live.** Minimal extension: hook returns a retain-none pointer, `setImmediate`-queues `/fresh`, `/fresh` calls `newSession`. Verify: no deadlock; aborted turn persists; `withSession` fires on the fresh session; the pointer prompt auto-starts a turn. This is the one source-inferred mechanism in the design.
2. Verify the race where `/fresh` executes while the auto-compaction abort controller is still set (extension commands bypass the prompt guard; confirm no conflict).
3. Confirm the runtime accepts `firstKeptEntryId: undefined` from the hook (types say `string`; cast if needed).

## What's left to the builder

- Exact TypeBox schemas for `recall` / `recall_get`; the JSONL reader (branch entries, partial trailing line, caps); result renderers; unit tests for the reader; install layout (repo dir → `~/.pi/agent/extensions/`), and a README with the measured cost numbers.
