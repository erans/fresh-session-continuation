import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NOTICES } from "./notices.js";
import { queueDispatch } from "./hook.js";
import { appendStateRecord, resolveActiveRecord, type SwitchStateInstance } from "./state.js";

const RECOVERY_WINDOW_MS = 60_000;

/**
 * session_start recovery (spec 4e): a persisted armed record on the active
 * branch re-arms and dispatches exactly one /fresh inside the window.
 * Reload re-hydrates without dispatching (never reached here: reload's
 * session_start reason is "reload" and is skipped).
 */
export function registerRecovery(pi: ExtensionAPI, st: SwitchStateInstance): void {
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "resume") return;
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;

		const record = resolveActiveRecord(ctx.sessionManager.getBranch(), file);
		if (!record) return; // absent, cleared, or fork-copied → silent no-op

		if (Date.now() - record.armedAt > RECOVERY_WINDOW_MS) {
			appendStateRecord(pi, {
				state: "cleared",
				owner: file,
				oldSessionPath: record.oldSessionPath,
				pointerTextStatic: record.pointerTextStatic,
				armedAt: record.armedAt,
			});
			ctx.ui.notify(NOTICES.degraded(undefined));
			return;
		}

		// in-memory re-arm only: the record keeps its original armedAt/owner/text
		st.arm({ oldSessionPath: record.oldSessionPath, pointerTextStatic: record.pointerTextStatic });
		queueDispatch(pi, st);
	});

	pi.on("session_shutdown", () => st.markInactive());
}
