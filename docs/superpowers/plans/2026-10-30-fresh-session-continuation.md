# Fresh-Session Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pi extension that replaces LLM-summary compaction with a retain-none pointer compaction plus an automatic in-process switch to a fresh session, with `recall`/`recall_get` retrieval over the session chain.

**Architecture:** One TypeScript extension (no build step — pi loads TS via jiti). A `session_before_compact` hook writes a zero-cost pointer compaction, arms a switch on `session_compact` confirmation, and defers a self-invoked `/fresh` command by one tick; `/fresh` creates the fresh session (`parentSession` link) and auto-submits the pointer prompt. Two render functions (static pointer + volatile block), an append-only persisted state record, a validated ancestor-chain reader, and two read-only tools complete it.

**Tech Stack:** TypeScript, `@earendil-works/pi-coding-agent` 1.4.0 (SDK for in-process tests), vitest, no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-30-fresh-session-continuation-design.md` — every value below is copied from it; read the spec's "How (decided)" section alongside this plan.

## Global Constraints

- pi ≥ 1.4.0; extension only — no pi-core changes. devDependency: `"@earendil-works/pi-coding-agent": "1.4.0"` (if unavailable from the registry, a `file:` link to the installed release at `~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent` is acceptable).
- **Zero LLM calls** anywhere in the switch path; **no arbitrary-path reads** (the `file` tool argument only ever matches a validated chain member); search is **literal-escaped by default**.
- Auto-switch only in `tui`/`rpc` modes; `print`/`json` get pointer compaction only.
- Never delete session files; records are append-only (`pi.appendEntry`).
- Exact values (verbatim): pointer target ~16 KB; pointer-walk budget ~10 MB / ~2 s / depth ~8; recall budget ~50 MB / ~10 s / depth ~8; result cap ~32 KB; per-file limit floor ~5; regex opt-in with query cap ~200 chars, ~64 KB match chunks; images from last user message only, ~4 count / ~1 MB; pre-prompt poll ~250 ms; recovery window ~1 minute.
- Notice strings are the spec's notice table, verbatim (Task 2 pins them in `notices.ts`; later tasks import, never restate).
- Retain-none marker: `firstKeptEntryId: null` (documented; cast past `CompactionResult`'s `string` type). If the spike proves it is not honored, the spec's named fallback applies (retain-tail pointer compaction) — stop and report before proceeding.
- Commit after every green test; conventional commits.

## Review Focus

Five input classes the spec implies; each line's test is pinned in the owning task.

1. **Hundreds-of-MB session files** — budgets must cut `recall`/`tail` walks with explicit truncation markers, never pin the turn. Test: Task 7, `large-file-budget.test` (generated ~60 MB fixture; asserts elapsed bound + unscanned marker + `nextCursor`).
2. **Hostile or hand-edited `parentSession`** (points outside the session dir, at `/etc/passwd`, at itself, or repeats a file) — validation stops the walk with the invalid-chain notice; cursors reject on digest mismatch. Tests: Task 4 (`invalid-ancestor`, `self-reference`, `repeat`, `digest-mismatch`).
3. **Mid-append partial trailing line** — the reader tolerates it. Test: Task 3 (`partial-trailing-line`).
4. **Extension-disabled resume of a pointer session** — the pointer text alone must orient the model (self-sufficiency line + file path). Test: Task 14 (`disable-compatibility`).
5. **Pathological regex (catastrophic backtracking)** — elapsed budget bounds the call; literal default needs no regex. Test: Task 7 (`pathological-regex-bounded`).

---

### Task 1: Test harness (scaffolding folded in)

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts` (testTimeout 60s, include `test/**/*.test.ts`), `.gitignore`
- Create: `test/harness/model.ts`, `test/harness/session.ts`
- Test: `test/harness.test.ts`

**Interfaces (Produces — every later integration task uses these):**
- `TurnScript` = one fake-model assistant response: `{ text?: string; toolCalls?: { name: string; args: unknown }[] }`
- `fakeProviderExtension(turns: TurnScript[]): ExtensionFactory` — registers provider `"fake"` / model `"fake-1"` (contextWindow 200000, small maxOutput) via `pi.registerProvider({ streamSimple })`, popping one `TurnScript` per model call (repeat the last when exhausted). Exact `registerProvider`/`streamSimple` shape: follow `custom-provider.md` and `dist/core/extensions/types.d.ts` in the installed package.
- `createTestSession(opts: { extensions?: ExtensionFactory[]; sessionDir: string; reserveTokens?: number; keepRecentTokens?: number }): Promise<TestSession>` — in-process `createAgentSession` with `DefaultResourceLoader({ extensionFactories: [fakeProviderExtension, ...opts.extensions] })`, file-backed `SessionManager` rooted at `sessionDir` (per-test temp dir), in-memory `SettingsManager` carrying `compaction.reserveTokens` (default 100 — forces the threshold on the first small turn) and the fake model selected.
- `TestSession` = `{ session: AgentSession; sessionFile(): string; readEntries(): SessionEntry[]; dispose(): Promise<void> }` — `readEntries` parses the JSONL via a local helper (not the production reader; the reader gets its own fixtures).
- `captureNotices(): { notices: string[]; extension: ExtensionFactory }` — harness extension wrapping `ctx.ui.notify` into an array (guard: only when `ctx.hasUI` is false in SDK mode, notify calls still reach the extension context — verify; if SDK sessions never render notify, capture via a `pi.on("...")`-independent spy injected through the tested extension's deps instead).

- [ ] **Step 1: Write the failing harness test** — creates a session, prompts `"start"`, asserts the scripted `TurnScript` text arrives (`session.getLastAssistantText()`), the session file exists in `sessionDir`, and a second session's `readEntries()` shows user+assistant messages.
- [ ] **Step 2: Run it to verify it fails** — `npx vitest run test/harness.test.ts`; expected: module not found.
- [ ] **Step 3: Implement harness** — `package.json` (devDeps pinned per Global Constraints; scripts: `test` = vitest run), `tsconfig.json` (module NodeNext, strict, types from the pi package), the two harness modules.
- [ ] **Step 4: Run tests** — `npx vitest run test/harness.test.ts`; expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "test: in-process SDK harness with scripted fake provider"`

### Task 2: Stage 0a spike — core mechanism (placeholder renderers, notices, minimal state)

Implements the spec's Stage 0a with a **fixed placeholder renderer** (literal strings); later tasks swap in the real ones. Everything here is retained as the permanent integration test `spike-core.test.ts`.

**Files:**
- Create: `src/index.ts` (default factory, wires modules), `src/notices.ts`, `src/state.ts`, `src/hook.ts`, `src/fresh.ts`
- Test: `test/integration/spike-core.test.ts`

**Interfaces (Produces):**
- `notices.ts`: `export const NOTICES = { ... }` — **exact strings from the spec's notice table** (all 12 rows; copy them verbatim from the spec, template slots as `<...>` placeholders filled by a `fill(template, vars)` helper). Also `export const STATE_RECORD_TYPE = "fresh-session-switch"`.
- `state.ts` (process-local machine + persisted records; consumed by hook/fresh/recovery):
  - `type SwitchState = "idle" | "armed" | "in-flight"`; `getState(): SwitchState`
  - `arm(payload: SwitchPayload): void`, `refreshInFlight(payload: SwitchPayload): void`, `toInFlight(): boolean` (false if already in-flight), `toIdle(): void`
  - `getCancelled(): boolean`, `setCancelled(): void`, `clearCancelled(): void`; `isActive(): boolean`, `markInactive(): void`; `getDispatchQueued(): boolean`, `setDispatchQueued(v: boolean): void`
  - `SwitchPayload = { oldSessionPath: string; pointerTextStatic: string }`
  - `persistArmedRecord(pi: ExtensionAPI, p: SwitchPayload): void` — appends `{ state: "armed", owner: currentSessionFile, ...p, armedAt: Date.now() }` via `pi.appendEntry(STATE_RECORD_TYPE, ...)`
  - `persistClearedRecord(pi: ExtensionAPI): void` — appends `{ state: "cleared", owner, oldSessionPath }`
  - `resolveActiveRecord(sm: ReadonlySessionManager): ArmedRecord | null` — newest entry of `STATE_RECORD_TYPE` on `sm.getBranch()` whose `owner` equals the current session file; null otherwise
- `hook.ts`: `registerCompactionHook(pi: ExtensionAPI): void` — the `session_before_compact` handler (threshold/overflow → placeholder static + `firstKeptEntryId: null`; manual bare → placeholder + `preparation.firstKeptEntryId`; `customInstructions` → return `undefined`; not persisted → `undefined` + notify once) plus the `session_compact` arming listener (reason filter + exact-summary match → `arm()`, `persistArmedRecord`, `setImmediate`-queue `/fresh` when `ctx.mode` is tui/rpc, with the self-guarding closure: `if (!isActive() || getCancelled() || getState() === "idle") return;` wrapped in try/catch) and `session_compact_failed` disarm.
- `fresh.ts`: `registerFreshCommand(pi: ExtensionAPI): void` — minimal for the spike: in-flight refusal, `toInFlight()`, assemble `PLACEHOLDER_STATIC + PLACEHOLDER_VOLATILE` (module consts), `ctx.newSession({ parentSession, withSession: rc => rc.sendUserMessage(prompt) })` with commit-point `persistClearedRecord` and last-step guard re-check, first-turn try/catch with the "switched, but continuation failed" notice.
- `index.ts`: `export default function (pi: ExtensionAPI)` registering hook + command (+ `pi.on("session_shutdown", markInactive)`).

- [ ] **Step 1: Write the failing spike test** — `createTestSession` with the extension loaded; one prompt with a large fake response (script text > reserveTokens) forcing the threshold mid-run; then assert within a poll window (~2 s): (a) the old session file gains a `compaction` entry whose `firstKeptEntryId` equals its own `id` and whose summary is the placeholder static; (b) a **new** session file appears in `sessionDir` whose header `parentSession` is the old file; (c) the new file's first user message is the pointer prompt; (d) exactly one new session was created; (e) no LLM summarization call occurred (the fake provider logs every call; assert call count grew only by the fresh first turn).
- [ ] **Step 2: Run to verify it fails** — expected: FAIL (no extension).
- [ ] **Step 3: Implement `notices.ts`, `state.ts`, `hook.ts`, `fresh.ts`, `index.ts`** per Interfaces.
- [ ] **Step 4: Run the spike** — expected: PASS.
- [ ] **Step 5: Add pre-prompt-ordering test** — second session; assert the fresh session's pointer prompt embeds the *triggering* prompt's text (placeholder volatile carries the branch's last user message at `/fresh` execution time). Run (fails — capture timing), implement the capture in `fresh.ts`, run (passes).
- [ ] **Step 6: Add restart-recovery test** — dispose the session while armed (script a threshold with the dispatch blocked via `markInactive()`), re-open the same session file in a fresh `createTestSession` (session_start reason `resume`), assert exactly one `/fresh` dispatch lands with the persisted static text unchanged + one rebuilt volatile block, and the recovered prompt equals `PLACEHOLDER_STATIC + volatile-from-branch`.
- [ ] **Step 7: Run all spike tests** — `npx vitest run test/integration/spike-core.test.ts`; expected: PASS (all Stage 0a exit criteria except renderer content, which is placeholder by design).
- [ ] **Step 8: Commit** — `git commit -m "feat: stage-0a spike — pointer compaction, deferred dispatch, fresh-session switch"`

### Task 3: JSONL reader (unit)

**Files:**
- Create: `src/reader.ts`, `test/fixtures/builder.ts` (programmatic JSONL fixture builder)
- Test: `test/unit/reader.test.ts`

**Interfaces (Produces — consumed by chain, tools, pointer TOC):**
- `streamEntries(file: string): AsyncGenerator<SessionEntry>` — line-by-line; skips a malformed **trailing** line silently, throws on a malformed interior line; never buffers the whole file.
- `parseSessionHeader(file): { id: string; cwd: string; parentSession?: string } | null`
- `isStateRecordEntry(e: SessionEntry): boolean` — `custom` entries with `customType === STATE_RECORD_TYPE`
- `entryRole(e): "user" | "assistant" | "toolResult" | "system" | "other"` and `entrySearchText(e): string` (concatenated text blocks; role-tagged lines like `[user] ...` are added by the caller, not here)
- `renderEntry(e): string` (verbatim content text for `recall_get`) and `entryImages(e): ImageContent[]`
- `firstUserLine(e): string | null` (TOC source)

- [ ] **Step 1: Write failing tests** — fixtures built with `builder.ts`: a tree with abandoned branches; per-file ID collisions across two files; a file ending in a half-written line; state-record custom entries; a `compaction` entry mid-file. Assert: stream yields entries in file order; partial trailing line skipped; `isStateRecordEntry` true only for our type; `renderEntry` returns exact block text; `firstUserLine` returns first line of user text.
- [ ] **Step 2: Run to verify failure** — module not found.
- [ ] **Step 3: Implement `reader.ts`** — pure functions over `readline`/`fs.createReadStream`; no pi imports except the `SessionEntry` type.
- [ ] **Step 4: Run tests** — PASS. **Step 5: Commit** — `test: streaming JSONL reader with fixtures`.

### Task 4: Chain resolution + cursor (unit)

**Files:**
- Create: `src/chain.ts`
- Test: `test/unit/chain.test.ts` (uses `builder.ts` for a 12-generation chain, cycles, invalid ancestors)

**Interfaces (Produces):**
- `ChainTarget = { file: string; label: string }` (label = `gen0` for the current file, `genN` ancestors)
- `POINTER_BUDGET = { maxBytes: 10_485_760, maxElapsedMs: 2000, maxDepth: 8 }`; `RECALL_BUDGET = { maxBytes: 52_428_800, maxElapsedMs: 10_000, maxDepth: 8 }`
- `resolveChain(sessionFile: string, sessionDir: string, budget): Promise<{ targets: ChainTarget[]; stoppedAt?: string; reason?: "invalid" | "cycle" | "budget" }>` — newest→oldest; validates each ancestor (exists, header parses as a session, realpath inside `sessionDir`); visited set of realpaths stops repeats with the invalid-chain reason.
- `mintCursor(c: { visitedDigest: string; chainIndex: number; byteOffset: number; query: string }): string` and `parseCursor(s: string): CursorState | null` — digest mismatch rejected by the caller with the invalid-chain notice.
- `shaDigest(paths: string[]): string` (visited-set digest, any stable hash)

- [ ] **Step 1: Write failing tests** — 12-generation chain resolves 8 targets + `stoppedAt` budget reason; self-referencing parent → `reason: "cycle"`; parent outside sessionDir and non-session file → `reason: "invalid"`; repeated file mid-chain → cycle; cursor round-trips and rejects a tampered digest.
- [ ] **Step 2: Verify failure.** **Step 3: Implement `chain.ts`.** **Step 4: Tests pass.** **Step 5: Commit** — `feat: validated ancestor-chain resolution with visited set and cursor`.

### Task 5: Pointer renderers (unit, golden files)

**Files:**
- Create: `src/pointer.ts`, `test/fixtures/golden/` (`.md` golden files)
- Test: `test/unit/pointer.test.ts`

**Interfaces (Produces):**
- `renderPointerStatic(i: { oldSessionPath: string; toc: TocEntry[]; readFiles: string[]; modifiedFiles: string[] }): string` — the spec's static sections in order: path line ("record is complete and verbatim"), TOC (first lines, terminal marker `"older sessions not indexed here: <files> — search them with recall, which continues past its budget via cursor"` on budget exhaustion), files read/modified, usage instruction with the cursor sentence, self-sufficiency line. `POINTER_CAP_BYTES = 16384` applied **inside the function** (TOC entries first, then file lists; path and instructions never truncated), reserving `VOLATILE_HEADROOM_BYTES = 4096`.
- `renderVolatileBlock(i: { lastUserMessage: string; images: ImageContent[]; anchor: Anchor }): string` — "you were mid-task; resume this" + verbatim message (oversized rule: truncate with marker pointing to `recall { tail }`), images note, anchor ("your most recent steps are entries X..Y — recall_get them before re-doing work" + boundary line). Capped against the headroom (anchor excerpt first, then the message).
- `Anchor = { lastAssistantText: string; entryRefs: { file: string; entryId: string }[]; boundaryEntryId?: string }`
- `assemblePrompt(staticText: string, volatileBlock: string): string`
- `minimalPointer(oldSessionPath: string, lastUserMessage: string): string` — self-sufficiency + path + message only.
- `buildTocFromFiles(files: { file: string; entries: SessionEntry[] }[], budget): { toc: TocEntry[]; exhaustedAfter?: string[] }` — first user line per entry, own active branch + ancestors' leaf paths, skipping state records.

- [ ] **Step 1: Write failing golden tests** — three assemblies (compaction summary = static + hook-time volatile; armed-payload prompt; manual regeneration omits file lists) against committed golden files; cap-as-function (a huge TOC input truncates TOC, never the path/instructions); oversized last message; images >4 or >1 MB capped with the notice text; budget-exhausted TOC marker; `minimalPointer` on unreadable-ancestor input.
- [ ] **Step 2: Verify failure.** **Step 3: Implement `pointer.ts`.** **Step 4: Golden tests pass (regenerate goldens via a `UPDATE_GOLDEN=1` env flag in the test).** **Step 5: Commit** — `feat: pointer renderers with cap-as-function and golden files`.

### Task 6: State records — resolution and clearing (unit)

**Files:**
- Modify: `src/state.ts` (extend with resolution/clearing already sketched; add helpers)
- Test: `test/unit/state.test.ts`

**Interfaces (Produces):**
- From Task 2 plus: `readBranchRecords(sm): StateRecord[]`; `clearPersistedOnNoSwitchExit(pi): void` (degraded notice / pre-flight failure / print-json skip paths); exceptions encoded as named functions `shouldClearOnExit(path: ExitPath): boolean` implementing the spec's 4f table (in-flight refusal: false; `session_before_switch` post-commit: false — commit-point already cleared; `session_tree` with flag: handled by the tree handler's own record).
- Mock `ExtensionAPI` for `pi.appendEntry` capture (test-local `makeFakePi()`).

- [ ] **Step 1: Write failing tests** — append-only clearing (armed then cleared = two records, newest wins); newest-on-branch resolution with `sm.getBranch()` fixtures; fork-copied record (owner mismatch) → `resolveActiveRecord` null; compaction-entry-then-custom-records fixture: recall-search and tail skip state records and tail stops at the newest compaction entry (assert via reader functions).
- [ ] **Step 2: Verify failure.** **Step 3: Implement/extend.** **Step 4: Pass.** **Step 5: Commit** — `feat: state-record resolution and clearing rules`.

### Task 7: `recall` + `recall_get` tools (unit)

**Files:**
- Create: `src/tools.ts`
- Test: `test/unit/tools.test.ts` (temp-dir fixtures via `builder.ts`; fake `ExtensionToolContext` with `ctx.sessionManager` pointing at a built session)

**Interfaces (Produces):**
- `makeRecallTool(deps: { sessionFile(): string; sessionDir(): string }): ToolDefinition` — TypeBox schema `{ query?: string; tail?: number; role?: "user"|"assistant"|"toolResult"; limit?: number; regex?: boolean; cursor?: string; file?: string }`, XOR validation (`query`/`tail`/`cursor` exactly one; `cursor` rejects `query`/`tail`/`file`, honors `role`/`limit`); literal-escaped substring default, regex opt-in (query ≤200 chars; >64 KB lines matched in 64 KB chunks with per-chunk elapsed check); global `limit` (default 25) with per-file floor 5 while unspent; hits interleaved newest-first by timestamp; result cap 32 KB with truncation marker; budget-cut walk → unscanned-file list + `nextCursor`; `tail` resolves the target (own newest `compaction` entry → else header `parentSession` → else current file) and applies the boundary rule to the resolved target; over-cap tail entry pages with `next: { file, entryId, offset }`; content = exact strings from `notices.ts` where notices apply.
- `makeRecallGetTool(deps): ToolDefinition` — schema `{ file: string; entryId: string; offset?: number } | { around: { file: string; entryId: string; before: number; after: number }; offset?: number }`; `file` validated against the **full** resolved ancestry (header-only, not depth-budgeted, own elapsed/byte cap with a notice on cap hit) — reject with the valid-target list otherwise; offset = UTF-8 byte offset into the rendered text; 32 KB shared cap; truncated fetch ends with the `next:` line.
- Search/tail skip state-record entries (`isStateRecordEntry`).

- [ ] **Step 1: Write failing tests** — Review Focus lines 1, 5 (large-file budget cut with markers + cursor; pathological regex bounded by elapsed budget); literal default escapes regex metacharacters; XOR validation errors; floor logic on a 12-file chain; tail precedence cases (own-compaction, parent-with-compaction boundary, plain, co-occurrence — per spec Stage 1 fixtures); `recall_get` on a chain deeper than the walk budget (cursor-resumed hit fetchable); `offset` replays a `next` line; `file`+`cursor` rejected; invalid `file` rejected with the valid list.
- [ ] **Step 2: Verify failure.** **Step 3: Implement `tools.ts`** (search loop consumes `streamEntries`, per-file matchers, budgets from `chain.ts`). **Step 4: Pass.** **Step 5: Commit** — `feat: recall and recall_get over validated chain`.

### Task 8: `session_tree` cancellation + guard terms (unit + harness)

**Files:**
- Create: `src/recovery.ts` (tree handler now; session_start handler added in Task 9)
- Modify: `src/state.ts` (nothing new — uses Task 2 flags), `src/fresh.ts` (last-step guard re-check before `newSession`; already stubbed in Task 2 — make it exact)
- Test: `test/unit/tree-cancel.test.ts` + additions to `test/integration/spike-core.test.ts`

**Interfaces:**
- `registerTreeHandler(pi: ExtensionAPI): void` — on `session_tree`: only when state is armed/in-flight → `setCancelled()`; append the cleared record via `persistClearedRecord`; consumerless case (`!getDispatchQueued()` and no parked `/fresh` — tracked by a module `parkedFresh` boolean set in `fresh.ts`) → emit the cancellation notice itself and `toIdle()`.
- Cancelled-flag lifetime: cleared on every `arm()`/re-arm and whenever the machine leaves armed/in-flight for idle (guard consumption or consumerless emit); never by the in-flight refresh.

- [ ] **Step 1: Write failing tests** — flag set only when armed/in-flight (idle `/tree` no-op: no record, no flag); cleared record appended when flag set; consumerless (dispatchQueued false) handler emits once + idle; in-flight refresh does not clear the flag (second-threshold-then-tree variant); integration: `/tree` during the drain aborts before `newSession` with exactly one notice and machine at idle.
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Pass.** **Step 5: Commit** — `feat: session_tree cancellation with consumerless handling`.

### Task 9: `session_start` recovery + never-dispatched detection (integration)

**Files:**
- Modify: `src/recovery.ts`, `src/index.ts`
- Test: `test/integration/recovery.test.ts`

**Interfaces:**
- `registerRecovery(pi: ExtensionAPI): void` — `session_start` handler per spec 4e (resolve active branch record; absent/not-armed/owner-mismatch → silent no-op; gates reason/mode/age; startup/resume in-window → re-arm in-memory-only + `setImmediate` one `/fresh`; reload → re-hydrate, never dispatch; print/json → cleared record + silent skip; else → cleared + degraded notice once); `agent_end` handler for the never-dispatched detection (state `armed` at `agent_end`, same session file → degraded notice + cleared record + log); dispatch deferred one tick (never inline).
- Re-armed record keeps original `armedAt`/`owner`/`pointerTextStatic` (read from the record; no re-append).

- [ ] **Step 1: Write failing tests** — startup-resume inside window: exactly one dispatch, recovered prompt = persisted static unchanged + one volatile block; expired gate: cleared + notice once; reload: guard early-returns (no dispatch), exactly one deferred degraded notice at the next `agent_end`; print/json: cleared record, no notice; fork of an armed session (`SessionManager` fork in harness): silent no-op; never-dispatched at `agent_end`.
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Pass (Stage 0b exit criteria subset).** **Step 5: Commit** — `feat: session_start recovery with never-dispatched detection`.

### Task 10: `/fresh` full path (integration — replaces the spike's minimal version)

**Files:**
- Modify: `src/fresh.ts` (full: drain, pre-flight, real renderers, pre-prompt poll, manual regeneration, first-turn wrap)
- Test: `test/integration/fresh.test.ts`

**Interfaces:**
- Steps per spec `/fresh` 1–7: in-flight refusal (`"a switch is already in progress"`); queued-input drain (`ctx.hasPendingMessages()` → `await ctx.waitForIdle()`, then immediate re-check, residual notice on the race window); pre-flight (old file readable, session dir writable, parent resolvable, model selected + auth resolves → on failure the pre-flight notice, stay on pointer mode); assembly (static = latest in-memory render; recovery → persisted; manual → regenerate without file lists; volatile = fresh branch-tail read under ~1 s budget); commit point (`persistClearedRecord` immediately before `ctx.newSession`, last-step guard re-check); first-turn failure wrapped ("switched, but continuation failed"); pre-prompt poll ~250 ms with the "newest prompt not yet persisted" notice on expiry.
- The spike's placeholder renderers are replaced by Task 5's functions (delete the placeholders).

- [ ] **Step 1: Write failing tests** — manual `/fresh` works end-to-end; refusal while in-flight; drain delivers queued input before the switch (assert delivered message persisted in the old session); pre-flight failure (make old file unreadable → notice, no switch); `session_before_switch` cancellation (harness extension that cancels) → stays on pointer mode, exactly one cleared record; simulated first-turn failure (fake provider rejects on the fresh session) → "switched, but continuation failed" + old path in the notice; manual regeneration omits file lists; pre-prompt poll expiry (scripted delay) → notice.
- [ ] **Step 2: Verify failure.** **Step 3: Implement the full command.** **Step 4: Pass (Stage 3 core).** **Step 5: Commit** — `feat: full /fresh switch path`.

### Task 11: Triggers and contracts (integration)

**Files:**
- Modify: `src/hook.ts` (final manual `/compact` semantics; not-persisted notify), `src/index.ts` (compaction-disabled check on `session_start`)
- Test: `test/integration/triggers.test.ts`

- [ ] **Step 1: Write failing tests** — three automatic reasons each produce the pointer + switch (threshold mid-run via multi-turn script with tool calls; run boundary; overflow via a fake-provider error + retry); manual bare `/compact` (`pi.compact()`... or session prompt of `/compact`) → pointer compaction **keeping** `preparation.firstKeptEntryId`, no auto-switch; `/compact <instructions>` → default compaction (undefined returned); `compaction.enabled: false` in settings → the compaction-disabled notice once, no dead-end; second threshold during a drain → payload refreshed, no second dispatch, `session_compact_failed` ignored; abort-controller race (assert `/fresh` during compaction doesn't throw — implicitly covered by spike, keep the assertion); deep mid-run: 30+ scripted tool-call turns before the threshold → fresh session resumes from the progress anchor and `recall { tail }` returns the old session's last entries verbatim, without re-running completed tool calls (fake model records tool calls it receives; assert none repeated).
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Pass (Stage 4a exit criteria).** **Step 5: Commit** — `feat: all three triggers, manual /compact contracts, compaction-disabled check`.

### Task 12: Exit and recovery matrix (integration)

**Files:**
- Test: `test/integration/matrix.test.ts` (failures surface fixes in state/recovery/fresh — keep them minimal)

- [ ] **Step 1: Write the failing matrix tests** (spec Stage 0b + 4b, those not already covered): switch-to-another-session-in-the-tick (case a: no record in the unrelated session; in-window resume dispatches once, past-window degrades once); two-restart (second after window degrades once); stale record (resume hours later — fake `armedAt` in the fixture); successful switch leaves the fresh session silent (no degraded notice, no spurious records); forks (`--fork`-style `SessionManager` fork + in-tree fork) silent; both mid-drain restart ages; `session_tree` matrix (during drain; branch-keeps-the-record → cleared record on the new leaf; idle-then-threshold dispatches normally; residual re-fire pair (a) append+restart → re-fires, (b) no append+restart → silent no-op); reload-then-`/tree` consumerless (one notice, one cleared record, idle); input submitted during the switch → residual notice.
- [ ] **Step 2: Verify failures.** **Step 3: Fix the surfaced gaps.** **Step 4: Pass (Stages 0b + 4b exit criteria).** **Step 5: Commit** — `test: full exit and recovery matrix`.

### Task 13: TUI, notices audit, modes (integration)

**Files:**
- Create: `src/tui.ts` (entry renderer: divider "— context moved onward; use recall —")
- Modify: `src/index.ts`
- Test: `test/integration/modes.test.ts`

- [ ] **Step 1: Write failing tests** — every notice emitted by any path matches `NOTICES` exactly (string equality against the table — audit by driving each path once); RPC-mode headless flow works (`ctx.hasUI` false paths); print/json: pointer compaction only, no dispatch, no spurious degraded notice; entry renderer registered for the pointer compaction (assert via `pi.registerEntryRenderer` call in a spy harness).
- [ ] **Step 2: Verify failure.** **Step 3: Implement `tui.ts` + wiring.** **Step 4: Pass (Stage 5).** **Step 5: Commit** — `feat: TUI renderer, exact notice strings, headless modes`.

### Task 14: Fixture generator, measurements, install, README

**Files:**
- Create: `scripts/fixture-session.ts` (reference-fixture generator: ~400k tokens of realistic tool traffic with a scripted task), `scripts/measure.ts` (runs the fixture through the harness, prints latency/cost/drain table rows), `README.md`
- Test: `test/integration/criteria.test.ts`

- [ ] **Step 1: Write the failing criteria tests** — 12-generation chain end-to-end (first call shows the not-scanned marker; cursor continuation reaches the oldest file; `recall_get` fetches the exact entry); disable-compatibility (build a pointer-compacted session, open it with **no** extension, assert the pointer text contains the old-session path and the read-tool self-sufficiency instruction); fixture generator produces a session file of the expected size class.
- [ ] **Step 2: Verify failure.** **Step 3: Implement scripts + README** (install: copy/symlink the repo dir into `~/.pi/agent/extensions/`; cost table with model/prices placeholder rows — the user fills measured numbers from a real-model run; drain-case row; `--no-session`/print/json limits; disable-compatibility; disk-growth/retention). **Step 4: Pass (Stage 6 + success criteria the harness can measure hermetically).** **Step 5: Commit** — `feat: fixture, measurements script, README and install layout`.

---

## Self-review notes (applied)

- **Spec coverage:** every spec stage maps to ≥1 task (0a→2, 1→3/4/6/7, 2→5, 3→10, 4a→11, 4b→12, 0b→9/12, 5→13, 6→14); the notice table → Task 2 + 13 audit; budgets/cursors → 4/7; success criteria → 14. Gap check: the "armed → in-flight payload refresh" rule is tested in 11 (second threshold during drain); the "agent_end never-dispatched" in 9.
- **Type consistency:** `SwitchPayload`, `STATE_RECORD_TYPE`, `ChainTarget`, budgets, and notice keys are defined once in 2/4 and referenced by name thereafter.
- **Proportion:** steps carry signatures, spec values, and test names — bodies are left to the implementer except where the spec fixes exact copy.
