import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NOTICES } from "./notices.js";
import { PLACEHOLDER_STATIC, renderVolatilePlaceholder } from "./spike.js";
import { appendStateRecord, type SwitchStateInstance } from "./state.js";

/**
 * session_before_compact handler + arming. The hook returns a zero-cost
 * pointer compaction (retain-none via firstKeptEntryId: null for automatic
 * reasons; pi's suggested cut for bare manual /compact; undefined for
 * /compact <instructions>). Arming happens only on a confirming
 * session_compact with an automatic reason and our exact summary text.
 */
export function registerCompactionHook(pi: ExtensionAPI, st: SwitchStateInstance): void {
	let lastSummary: string | null = null;
	let notifiedNotPersisted = false;

	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.sessionManager.getSessionFile() == null) {
			if (!notifiedNotPersisted) {
				notifiedNotPersisted = true;
				ctx.ui.notify(NOTICES.notPersisted());
			}
			return;
		}
		try {
			const volatile = renderVolatilePlaceholder(ctx);
			const summary = `${PLACEHOLDER_STATIC}\n${volatile}`;
			lastSummary = summary;
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
			return {
				compaction: {
					summary: `${PLACEHOLDER_STATIC}\nlast user message: (partial — recall the record)\n${
						event.reason === "manual" ? "" : ""
					}`.trim(),
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
		if (!oldSessionPath) return;

		const payload = { oldSessionPath, pointerTextStatic: PLACEHOLDER_STATIC };
		appendStateRecord(pi, {
			state: "armed",
			owner: oldSessionPath,
			oldSessionPath,
			pointerTextStatic: PLACEHOLDER_STATIC,
			armedAt: Date.now(),
		});
		if (st.getState() === "in-flight") {
			st.refreshInFlight(payload); // process-local refresh; record keeps its original armedAt
			return;
		}
		st.arm(payload);

		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return; // print/json: pointer compaction only
		queueDispatch(pi, st);
	});

	pi.on("session_compact_failed", async () => {
		if (st.getState() === "armed") st.toIdle(); // disarm; nothing was switched
	});
}

/** Self-guarding deferred dispatch, shared by arming and recovery. */
export function queueDispatch(pi: ExtensionAPI, st: SwitchStateInstance): void {
	if (st.getDispatchQueued()) return;
	st.setDispatchQueued(true);
	setImmediate(() => {
		try {
			if (!st.isActive() || st.getCancelled() || st.getState() === "idle") return;
			pi.sendUserMessage("/fresh", { expandPromptTemplates: true });
		} catch {
			// stale-runner throw or rejected send → not dispatched; the persisted
			// armed record plus the next-agent_end detection covers it
		} finally {
			st.setDispatchQueued(false);
		}
	});
}
