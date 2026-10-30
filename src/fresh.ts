import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NOTICES, STATE_RECORD_TYPE } from "./notices.js";
import { PLACEHOLDER_STATIC, renderVolatilePlaceholder } from "./spike.js";
import { appendStateRecord, type SwitchStateInstance } from "./state.js";

/**
 * /fresh — auto-invoked at the threshold (via the deferred dispatch) and
 * manually invocable. Creates the fresh session with a parentSession link
 * and auto-submits the pointer prompt as its first message.
 */
export function registerFreshCommand(pi: ExtensionAPI, st: SwitchStateInstance): void {
	pi.registerCommand("fresh", {
		description: "Continue in a fresh session; the previous session stays fully recallable",
		handler: async (_args, ctx) => {
			if (st.getState() === "in-flight") {
				ctx.ui.notify(NOTICES.inProgress());
				return;
			}
			st.toInFlight();
			try {
				const payload = st.getPayload();
				const oldSessionPath = payload?.oldSessionPath ?? ctx.sessionManager.getSessionFile();
				if (!oldSessionPath) {
					ctx.ui.notify(NOTICES.preflight("no session file"));
					st.toIdle();
					return;
				}
				const staticText = payload?.pointerTextStatic ?? PLACEHOLDER_STATIC;
				const prompt = `${staticText}\n${renderVolatilePlaceholder(ctx)}`;

				// last-step guard, then the commit point: clearing the record
				// immediately before newSession is the only clearing past this point
				if (st.getCancelled() || !st.isActive()) {
					st.clearCancelled();
					st.toIdle();
					return;
				}
				appendStateRecord(pi, {
					state: "cleared",
					owner: oldSessionPath,
					oldSessionPath,
					pointerTextStatic: staticText,
					armedAt: Date.now(),
				});

				const result = await ctx.newSession({
					parentSession: oldSessionPath,
					withSession: async (rc) => {
						const newFile = rc.sessionManager.getSessionFile();
						if (newFile) rc.ui.notify(NOTICES.switch(newFile, oldSessionPath));
						try {
							await rc.sendUserMessage(prompt);
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							rc.ui.notify(NOTICES.continuationFailed(message));
						}
					},
				});

				if (result.cancelled) {
					// no replacement happened; record already cleared at the commit point
					ctx.ui.notify(NOTICES.degraded("session_before_switch"));
				}
			} finally {
				st.toIdle();
			}
		},
	});
}

export { STATE_RECORD_TYPE };
