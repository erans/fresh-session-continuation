# fresh-session continuation

A pi coding-agent extension that replaces LLM-summary compaction with **retrieval**.
When the context fills, pi's compaction machinery is intercepted: instead of paying
for a lossy summary, a zero-cost **pointer compaction** is written (the context
becomes `[system][pointer]`), and the agent automatically continues in a **fresh
session** whose first message is a mechanical pointer prompt. Nothing is
summarized — the previous session's complete JSONL record stays on disk, and the
`recall` / `recall_get` tools fetch exact lines from it on demand.

- Fully automatic at pi's existing triggers: threshold (mid-run or run boundary),
  pre-prompt, and context overflow. Works exactly where compaction works today.
- Never leaves the running pi instance — the switch is an in-process
  `newSession({ parentSession })`.
- **Lossless**: every generation's raw record is kept verbatim; the pointer names
  its source file and the toolchain reads it back byte-for-byte.
- A failed switch degrades to same-session pointer+recall continuation — never a
  dead run.

## Install

Pi loads direct TypeScript files (or subdirectories with an `index.ts`) from your
extensions directory. From this repo:

```sh
git clone <this repo> ~/fresh-session-continuation
ln -s ~/fresh-session-continuation/src ~/.pi/agent/extensions/fresh-session-continuation
```

(The symlink makes `src/index.ts` the subdirectory entry point; the repo's
`node_modules` provides `@earendil-works/pi-coding-agent` and `pi-tui`.)

Requires: pi 1.4.0+ (`@earendil-works/pi-coding-agent`), compaction enabled (the
default).

## What happens at the threshold

1. `session_before_compact` renders the pointer (old session path, index of user
   messages, files read/modified, the last user message, a progress anchor) and
   returns it as the compaction summary with `firstKeptEntryId: null`
   (retain-none). Zero LLM calls.
2. On the confirming `session_compact`, an `armed` state record is appended to the
   session (crash-safety) and `/fresh` is dispatched.
3. `/fresh` drains queued input, runs pre-flight checks, re-checks for
   cancellation, clears the record, and switches: the new session's first message
   is the pointer prompt, auto-submitted.
4. The agent continues; `recall` and `recall_get` retrieve from the old record.

Manual use: `/fresh` at any time; `/compact` writes a pointer compaction
(keeping pi's retain-tail cut) without switching; `/compact <instructions>`
falls through to pi's default LLM summary.

## Tools

- `recall { query | tail | cursor }` — literal substring search (opt-in `regex`,
  capped), tail review, or budget-cut continuation across the whole validated
  ancestor chain. Results cap at ~32 KB with a resumable cursor.
- `recall_get { file, entryId, offset? }` — fetch one entry (or a window
  `around`) verbatim, with byte-offset paging.

## Cost and latency

Mechanism-only numbers from the repo harness (fake provider, 3.6 MB /
~890k-token reference fixture — `npx tsx scripts/measure.ts`):

| measurement | value |
|---|---|
| switch latency, trigger → fresh first turn (no queue) | 124 ms |
| switch cost (pointer compaction is pure rendering) | $0.00 |
| pointer compaction size (this fixture) | 1.1 KB (~282 tokens) |

Real-model rows — fill from a run with your model and price table:

| measurement | value |
|---|---|
| fresh first turn + recall calls, 128k model at $_/M in, $_/M out | _fill_ |
| one default LLM compaction of the same record (comparison) | _fill_ |
| drain case (queued input remainder): N turns, T s, $X | _fill_ |

## Limits and compatibility

- **`--no-session`** (unpersisted): recall is unavailable; the hook notifies once
  and pi's default compaction runs.
- **print / json modes**: pointer compaction only — no auto-switch (the armed
  record persists; an interactive resume inside the ~1-minute window dispatches
  it once). No spurious notices.
- **Extension disabled**: the pointer text is self-sufficient — it names the old
  session file and instructs reading it with the ordinary read/bash tools; the
  raw record is also reachable via `/tree` and the session picker.
- **Disk growth**: the extension never deletes session files — the record is the
  product. Each continuation adds one session file; the switch notice and each
  pointer name their file, so chain members are identifiable. Prune manually via
  the session picker (`Ctrl+D` → trash). Automatic pruning of pointer-only
  intermediate sessions is deliberately deferred: a wrong prune destroys the
  record this design exists to keep.

## Development

```sh
npx tsc --noEmit   # types
npx vitest run      # 85 tests: unit + integration (harness with a scripted fake provider)
npx tsx scripts/fixture-session.ts   # generate the reference fixture
npx tsx scripts/measure.ts           # print the measurement table
```

Design spec: `docs/superpowers/specs/2026-10-30-fresh-session-continuation-design.md`.
Implementation plan: `docs/superpowers/plans/2026-10-30-fresh-session-continuation.md`.
