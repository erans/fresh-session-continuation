import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSwitchState } from "./state.js";
import { registerCompactionHook } from "./hook.js";
import { registerFreshCommand } from "./fresh.js";
import { registerRecovery, registerTreeHandler } from "./recovery.js";
import { registerTui } from "./tui.js";
import { makeRecallGetTool, makeRecallTool } from "./tools.js";
import { NOTICES } from "./notices.js";

export { STATE_RECORD_TYPE } from "./notices.js";

/** Warn once per process: with compaction disabled, pi never reaches our hook. */
let warnedCompactionDisabled = false;

/**
 * fresh-session continuation: replaces pi's LLM-summary compaction with a
 * zero-cost retain-none pointer compaction plus an automatic switch to a
 * fresh session that retrieves from the full record.
 */
export default function freshSessionExtension(pi: ExtensionAPI): void {
	const st = createSwitchState();
	registerCompactionHook(pi, st);
	registerFreshCommand(pi, st);
	registerTreeHandler(pi, st);
	registerRecovery(pi, st);
	registerTui(pi);
	pi.registerTool(makeRecallTool());
	pi.registerTool(makeRecallGetTool());

	pi.on("session_start", (_event, ctx) => {
		if (warnedCompactionDisabled) return;
		if (pi.getSettings().compaction?.enabled === false) {
			warnedCompactionDisabled = true;
			ctx.ui.notify(NOTICES.compactionDisabled());
		}
	});
}
