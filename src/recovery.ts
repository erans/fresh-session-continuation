import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NOTICES } from "./notices.js";
import { queueDispatch } from "./hook.js";
import { appendStateRecord, resolveActiveRecord, type StateRecordData, type SwitchStateInstance } from "./state.js";

const RECOVERY_WINDOW_MS = 60_000;

/**
 * session_tree handler (spec 4d): the handler has three responsibilities
 * and only those — set the cancelled flag (only when armed/in-flight),
 * append the cleared record when it does, and in the consumerless case emit
 * the single notice itself and return the machine to idle. The flag
 * consumer (dispatch closure or parked /fresh) emits otherwise.
 */
export function registerTreeHandler(pi: ExtensionAPI, st: SwitchStateInstance): void {
	pi.on("session_tree", async (_event, ctx) => {
		const state = st.getState();
		if (state !== "armed" && state !== "in-flight") return; // idle /tree: no-op
		st.setCancelled();
		const file = ctx.sessionManager.getSessionFile() ?? "";
		appendStateRecord(pi, {
			state: "cleared",
			owner: file,
			oldSessionPath: st.getPayload()?.oldSessionPath ?? file,
			pointerTextStatic: st.getPayload()?.pointerTextStatic ?? "",
			armedAt: Date.now(),
		});
		if (!st.getDispatchQueued() && !st.getParkedFresh()) {
			// consumerless (the re-hydrated armed state after a reload)
			ctx.ui.notify(NOTICES.treeCancelled());
			st.clearCancelled();
			st.toIdle();
		}
	});
}

function clearedFrom(record: StateRecordData): StateRecordData {
	return { ...record, state: "cleared" };
}

/**
 * session_start recovery (spec 4e) plus the never-dispatched detection at
 * agent_end. Records resolve on the active branch only; absent, cleared,
 * or fork-copied records are silent no-ops.
 */
export function registerRecovery(pi: ExtensionAPI, st: SwitchStateInstance): void {
	pi.on("session_start", async (event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		const record = resolveActiveRecord(ctx.sessionManager.getBranch(), file);

		if (event.reason === "reload") {
			// re-hydrate in-memory only; never dispatch (4e)
			if (record) st.arm({ oldSessionPath: record.oldSessionPath, pointerTextStatic: record.pointerTextStatic });
			return;
		}

		if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
			// print/json: cleared record, skip silently
			if (record) appendStateRecord(pi, clearedFrom(record));
			return;
		}

		if (event.reason !== "startup" && event.reason !== "resume") return; // "new"/"fork": silent
		if (!record) return; // nothing armed for this file: silent no-op

		if (Date.now() - record.armedAt > RECOVERY_WINDOW_MS) {
			appendStateRecord(pi, clearedFrom(record));
			ctx.ui.notify(NOTICES.degraded(undefined));
			return;
		}

		// in-memory re-arm only: the record keeps its original armedAt/owner/text
		st.arm({ oldSessionPath: record.oldSessionPath, pointerTextStatic: record.pointerTextStatic });
		queueDispatch(pi, st, (m) => ctx.ui.notify(m));
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (st.getState() !== "armed") return; // in-flight never triggers
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		const payload = st.getPayload();
		if (!payload || payload.oldSessionPath !== file) return;
		// the dispatch never ran: one degraded notice, cleared record, back to idle
		appendStateRecord(pi, {
			state: "cleared",
			owner: file,
			oldSessionPath: payload.oldSessionPath,
			pointerTextStatic: payload.pointerTextStatic,
			armedAt: Date.now(),
		});
		ctx.ui.notify(NOTICES.degraded(undefined));
		st.toIdle();
	});

	pi.on("session_shutdown", () => st.markInactive());
}
