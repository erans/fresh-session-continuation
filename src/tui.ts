import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { STATE_RECORD_TYPE } from "./notices.js";
import type { StateRecordData } from "./state.js";

/**
 * TUI rendering: the switch state records render as a single divider — the
 * visible "context moved onward" marker in the transcript. (pi 1.4.0's
 * registerEntryRenderer only styles CustomEntry types, so the compaction
 * entry itself keeps pi's default summary rendering.)
 */
export function registerTui(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<StateRecordData>(STATE_RECORD_TYPE, (_entry, _options, theme) => {
		const box = new Box(0, 0, (text) => text);
		box.addChild(new Text(theme.fg("dim", "— context moved onward; use recall —"), 0, 0));
		return box;
	});
}
