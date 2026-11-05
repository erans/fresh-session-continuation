# fresh-session continuation

**Your agent's context filled up. Nothing had to be summarized, re-read, or re-explained.**

A [pi](https://pi.dev) extension that replaces LLM-summary compaction with a **zero-cost pointer** plus a **fresh session** that can still recall every line of the old one, verbatim.

```sh
pi install npm:fresh-session-continuation
```

---

## The problem with compaction

Every long agent session ends the same way. The context window fills, so the harness calls a model to summarize everything so far, throws the original away, and continues from a lossy paraphrase. Then it happens again. And again, each generation summarizing a summary.

You pay for every one of those passes — a full request over your entire context, the single most expensive call a session ever makes — and in exchange you get **degradation**: the exact error message becomes "an error occurred", the file path becomes "a config file", the number you agreed on forty turns ago quietly becomes a different number. The agent re-reads files it already read, re-runs commands it already ran, and asks you things you already answered.

The record was never the problem. Nobody kept it.

## What this does

When pi decides the context is full, this extension intercepts the compaction and pays **zero tokens** for it:

1. **A pointer compaction lands** — no model call. The context becomes `[system prompt][pointer]`, where the pointer names the old session file, indexes its user messages, lists the files touched, and restates the task and last progress.
2. **A fresh session starts automatically** — in the same process, same terminal, linked to the old one as its parent. The pointer is its first message. No copy-paste, no `/clear`, no re-prompting.
3. **The full record stays on disk** — the previous session's JSONL is never truncated, summarized, or deleted. Two tools (`recall`, `recall_get`) search it and fetch exact lines on demand, across the whole ancestor chain.

Same trigger points as before — threshold, pre-prompt, context overflow — so it behaves exactly like compaction, minus the loss and minus the bill.

## Why it's different

| | Default compaction | fresh-session continuation |
|---|---|---|
| Cost of compacting | A full model pass over the whole context | **$0** — pointer rendering is text formatting |
| What survives | A paraphrase, then a paraphrase of a paraphrase | **Every byte**, on disk, searchable |
| After 10 compactions | The 10th summary of a summary | The original record, all 10 generations |
| Exact strings (errors, paths, numbers) | Lost, or hallucinated back | Fetched verbatim |
| Failure mode | Silent drift | Loud notice + safe pointer fallback |
| Context after a switch | Summary + retained tail | System prompt + pointer (~4k tokens) |

## How it works

```
context hits the threshold
        │
        ├─ session_before_compact ──► pointer text (no LLM call)
        │                              firstKeptEntryId: null  →  retain none
        ├─ session_compact ─────────► armed record persisted (crash safety)
        │
        └─ /fresh ──────────────────► drain queued input
                                       pre-flight: file readable? dir writable? model set?
                                       newSession({ parentSession: old })
                                       └─► pointer becomes the first message
                                             └─► agent continues, recall() at will
```

The switch is **guarded at every step**: the pointer compaction always lands *before* anything risky, so a failed switch degrades to continuing in the same session with pointer + recall. There is no path where a full context leaves you with a dead run.

## Install

### From npm (recommended)

```sh
pi install npm:fresh-session-continuation
```

### From git, pinned to a release tag

```sh
pi install git:github.com/erans/fresh-session-continuation@v0.1.0
```

### From a local checkout

```sh
git clone https://github.com/erans/fresh-session-continuation
pi install ./fresh-session-continuation
```

Requires pi 1.4.0+ with compaction enabled (the default). The extension warns once if you've turned compaction off — with it off, pi never reaches the hook.

## Usage

Mostly, you don't. It fires on its own:

| Trigger | What happens |
|---|---|
| Context threshold (mid-run or at a run boundary) | Pointer compaction + automatic switch |
| Pre-prompt threshold | Pointer compaction + automatic switch |
| Context overflow (provider rejects) | Pointer compaction + automatic switch |

And when you want control:

| Command | Behavior |
|---|---|
| `/fresh` | Switch to a fresh session right now |
| `/compact` | Pointer compaction only — keeps pi's retained tail, **never** switches |
| `/compact <instructions>` | Your instructions, pi's normal LLM summary (opt-out) |

## The tools

Both are read-only and scoped to the current session plus its validated ancestors — never an arbitrary path.

**`recall`** — search the record, review recent steps, or continue a cut search:

```jsonc
{ "query": "ECONNREFUSED" }          // literal substring, escaped by default
{ "query": "timeout|refused", "regex": true }
{ "tail": 20 }                        // last 20 entries, before the newest compaction
{ "cursor": "eyJ2aXNpdGVk…" }         // continue exactly where the last walk stopped
```

**`recall_get`** — fetch one entry (or a window around it) verbatim, with offset paging for entries larger than the result cap:

```jsonc
{ "file": "/sessions/old.jsonl", "entryId": "a1b2c3d4" }
{ "around": { "file": "/sessions/old.jsonl", "entryId": "a1b2c3d4", "before": 3, "after": 3 } }
```

Results cap at ~32 KB with a resumable cursor, so the model can page instead of blowing up its own context. Enumeration is budgeted (bytes, elapsed time, chain depth), and a budget cut always returns a cursor — never a silent miss.

## Numbers

Measured in this repo's harness against a generated 3.6 MB / ~890k-token session of realistic tool traffic (`npx tsx scripts/measure.ts`):

| Measurement | Value |
|---|---|
| Switch latency, threshold → fresh session's first turn | **124 ms** |
| Cost of the switch itself | **$0.00** |
| Pointer compaction size | **1.1 KB** (~282 tokens) |

The model here is a scripted fake, so those are machinery numbers: the pointer rendering, the queue drain, the pre-flight, the session replacement, the first-turn dispatch. They are the part this extension controls. The first turn's own cost is whatever your model charges for ~4k tokens of pointer plus the `recall` calls it decides to make — deliberately re-measured rather than assumed before any dollar figure is published here. (One compaction of that same session, by contrast, is a full model pass over ~890k tokens.)

## Limits, stated plainly

- **`--no-session`**: no file on disk means nothing to recall. You get one notice and pi's default compaction.
- **print / json modes**: pointer compaction only, no auto-switch (nothing to hand off to). An armed record persists, so resuming interactively within ~1 minute picks it up.
- **Images** are not returned by `recall` (text only). The switch re-attaches the last user message's images, capped at 4.
- **Disk growth is intentional**: the record *is* the product. Each continuation adds one session file. Nothing is ever deleted automatically; prune by hand from the session picker if you want to.
- **Extension disabled**: the pointer text is self-sufficient. It names the old session file and tells the model to read it with plain `read`/`bash`, so a session survives losing the extension.
- **Not a memory system.** It recalls *this* conversation's ancestry. Nothing is shared between unrelated sessions.

## Development

```sh
npm ci
npm run check     # typecheck + 92 tests (unit + integration on a scripted-provider harness)
npx tsx scripts/fixture-session.ts   # generate the 400k-token reference fixture
npx tsx scripts/measure.ts           # print the measurement table
```

No build artifact: pi loads extensions from TypeScript (`pi.extensions` in `package.json`), so `npm run build` is a typecheck gate on exactly what ships.

Design and decisions live in [`docs/superpowers/specs/`](docs/superpowers/specs/) and [`docs/superpowers/plans/`](docs/superpowers/plans/).

## Releasing

Versions are cut by tag, and publishing happens in CI with **npm Trusted Publishing** — no long-lived npm token anywhere.

```sh
npm version patch        # or minor / major — writes package.json + commit + tag
git push --follow-tags   # tag push starts the release
```

The tag must equal `package.json` (`v0.1.1` ↔ `0.1.1`); the workflow fails fast otherwise. On a tag the workflow:

1. installs, typechecks and tests (`npm run check`),
2. publishes to npm with `--provenance` — npm trades the GitHub OIDC token for short-lived credentials,
3. creates the GitHub Release with generated notes.

One-time bootstrap, because a trusted publisher is configured *on an existing package*:

```sh
npm login
npm publish --access public                         # first release only
npm trust github fresh-session-continuation \
  --file .github/workflows/release.yml \
  --repo erans/fresh-session-continuation \
  --allow-publish                                   # everything after this is tokenless
```

## License

MIT © Eran Sandler
