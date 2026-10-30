import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Stage 0a placeholder renderer. The real `renderPointerStatic` /
 * `renderVolatileBlock` (Task 5) replace the static part; the volatile
 * capture below is real and stays: the branch's last user message and a
 * minimal progress anchor, read at each assembly.
 */
export const PLACEHOLDER_STATIC =
	"FRESH-SESSION POINTER (placeholder static): the complete, verbatim record of the previous session is preserved in the session file. Retrieve exact context with the recall tools as you go.";

function textOf(entry: SessionEntry): string | null {
	if (entry.type !== "message") return null;
	const message = entry.message as { role: string; content: unknown };
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
			.map((b) => b.text)
			.join("\n");
	}
	return null;
}

/** Volatile block: last user message + last assistant progress anchor, from the branch. */
export function renderVolatilePlaceholder(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	let lastUser: string | null = null;
	let lastAssistant: SessionEntry | null = null;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message as { role: string };
		if (message.role === "user" && lastUser === null) lastUser = textOf(entry);
		if (message.role === "assistant" && !lastAssistant) lastAssistant = entry;
		if (lastUser !== null && lastAssistant) break;
	}
	const lines: string[] = [];
	if (lastUser !== null) {
		const clipped = lastUser.length > 2000 ? `${lastUser.slice(0, 2000)}…[truncated]` : lastUser;
		lines.push(`last user message: ${clipped}`);
	}
	if (lastAssistant) {
		const text = textOf(lastAssistant);
		if (text) {
			const clipped = text.length > 1000 ? `${text.slice(0, 1000)}…[truncated]` : text;
			lines.push(`last assistant progress: ${clipped}`);
			lines.push(`your most recent steps end at entry ${lastAssistant.id} — recall them before re-doing work`);
		}
	}
	if (lines.length === 0) lines.push("no prior messages on the branch");
	return lines.join("\n");
}
