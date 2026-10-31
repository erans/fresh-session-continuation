import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NOTICES } from "./notices.js";
import {
	assemblePrompt,
	buildTocFromFiles,
	renderPointerStatic,
	renderVolatileBlock,
	type Anchor,
} from "./pointer.js";
import { appendStateRecord, type SwitchStateInstance } from "./state.js";
import { captureBranchSnapshot } from "./fresh.js";
import { leafPathEntries } from "./reader.js";
import { POINTER_BUDGET, resolveChain } from "./chain.js";

/**
 * session_before_compact handler + arming. The hook returns a zero-cost
 * pointer compaction (retain-none via firstKeptEntryId: null for automatic
 * reasons; pi's suggested cut for bare manual /compact; undefined for
 * /compact <instructions>). Arming happens only on a confirming
 * session_compact with an automatic reason and our exact summary text.
 */
export function registerCompactionHook(pi: ExtensionAPI, st: SwitchStateInstance): void {
	let lastSummary: string | null = null;
	let lastStatic: string | null = null;
	let notifiedNotPersisted = false;

	pi.on("session_before_compact", async (event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			if (!notifiedNotPersisted) {
				notifiedNotPersisted = true;
				ctx.ui.notify(NOTICES.notPersisted());
			}
			return;
		}
		try {
			// static: path, TOC (own branch + ancestor leaf paths, budgeted), file lists
			const sessionDir = ctx.sessionManager.getSessionDir();
			const tocFiles = [{ file: sessionFile, entries: ctx.sessionManager.getBranch() }];
			if (sessionDir) {
				const chain = await resolveChain(sessionFile, sessionDir, POINTER_BUDGET);
				for (const target of chain.targets.slice(1)) {
					tocFiles.push({
						file: target.file,
						entries: await leafPathEntries(target.file, POINTER_BUDGET.maxBytes),
					});
				}
			}
			const { toc } = buildTocFromFiles(tocFiles, { maxTocEntries: 400 });
			const fileOps = event.preparation.fileOps as {
				read: Set<string>;
				written: Set<string>;
				edited: Set<string>;
			};
			const staticText = renderPointerStatic({
				oldSessionPath: sessionFile,
				toc,
				readFiles: [...fileOps.read],
				modifiedFiles: [...new Set([...fileOps.edited, ...fileOps.written])],
			});

			// volatile: captured at hook time for the compaction-summary assembly
			const snapshot = await captureBranchSnapshot(ctx);
			const summary = assemblePrompt(
				staticText,
				renderVolatileBlock({ ...snapshot.volatile, images: snapshot.volatile.images.slice(0, 4) }),
			);
			lastSummary = summary;
			lastStatic = staticText;

			if (event.reason === "manual") {
				if (event.customInstructions) return; // explicit summary request → default LLM compaction
				return {
					compaction: {
						summary,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			}
			return {
				compaction: {
					summary,
					// retain-none: the documented marker (cast past CompactionResult's string type)
					firstKeptEntryId: null as unknown as string,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		} catch (error) {
			// never let the hook throw: a throw silently reverts to the default LLM compaction
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(NOTICES.minimalPointer(message));
			const snapshot = await captureBranchSnapshot(ctx);
			return {
				compaction: {
					summary: assemblePrompt(
						minimalPointerText(sessionFile),
						renderVolatileBlock({ ...snapshot.volatile, images: [] }),
					),
					firstKeptEntryId:
						event.reason === "manual"
							? event.preparation.firstKeptEntryId
							: (null as unknown as string),
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		if (!event.fromExtension) return;
		if (event.reason === "manual") return; // a bare /compact never arms a switch
		if (!event.compactionEntry || event.compactionEntry.summary !== lastSummary) return;
		const oldSessionPath = ctx.sessionManager.getSessionFile();
		if (!oldSessionPath || !lastStatic) return;

		const payload = { oldSessionPath, pointerTextStatic: lastStatic };
		appendStateRecord(pi, {
			state: "armed",
			owner: oldSessionPath,
			oldSessionPath,
			pointerTextStatic: lastStatic,
			armedAt: Date.now(),
		});
		if (st.getState() === "in-flight") {
			st.refreshInFlight(payload); // process-local refresh; record keeps its original armedAt
			return;
		}
		st.arm(payload);

		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return; // print/json: pointer compaction only
		queueDispatch(pi, st, (m) => ctx.ui.notify(m));
	});

	pi.on("session_compact_failed", async () => {
		if (st.getState() === "armed") st.toIdle(); // disarm; nothing was switched
	});
}

function minimalPointerText(oldSessionPath: string): string {
	return [
		`Previous session (complete, verbatim record): ${oldSessionPath}`,
		"",
		"Do not re-ask the user. When you need the exact error message, file path, number, or prior decision, search the record with `recall` instead of re-deriving — if a search reports unscanned files, continue it with the returned cursor.",
		"If the `recall` tool is not available (extension disabled), read the session file directly with the read/bash tools.",
	].join("\n");
}

/** Self-guarding deferred dispatch, shared by arming and recovery. */
export function queueDispatch(
	pi: ExtensionAPI,
	st: SwitchStateInstance,
	notify: (message: string) => void,
): void {
	if (st.getDispatchQueued()) return;
	st.setDispatchQueued(true);
	setImmediate(async () => {
		try {
			if (st.getCancelled()) {
				// the flag consumer: one notice, machine back to idle
				notify(NOTICES.treeCancelled());
				st.clearCancelled();
				st.toIdle();
				return;
			}
			if (!st.isActive() || st.getState() === "idle") return;
			await pi.sendUserMessage("/fresh", { expandPromptTemplates: true });
		} catch {
			// stale-runner throw or rejected send → not dispatched; the persisted
			// armed record plus the next-agent_end detection covers it
		} finally {
			st.setDispatchQueued(false);
		}
	});
}
