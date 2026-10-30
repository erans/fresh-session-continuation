import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSwitchState } from "./state.js";
import { registerCompactionHook } from "./hook.js";
import { registerFreshCommand } from "./fresh.js";
import { registerRecovery } from "./recovery.js";

export { PLACEHOLDER_STATIC, renderVolatilePlaceholder } from "./spike.js";
export { STATE_RECORD_TYPE } from "./notices.js";

/**
 * fresh-session continuation: replaces pi's LLM-summary compaction with a
 * zero-cost retain-none pointer compaction plus an automatic switch to a
 * fresh session that retrieves from the full record.
 */
export default function freshSessionExtension(pi: ExtensionAPI): void {
	const st = createSwitchState();
	registerCompactionHook(pi, st);
	registerFreshCommand(pi, st);
	registerRecovery(pi, st);
}
