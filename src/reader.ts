import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { closeSync, openSync, readSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { STATE_RECORD_TYPE } from "./notices.js";
/**
 * The last `n` entries of a file's history after its newest compaction entry
 * (the compaction boundary resets the window), skipping entries the caller
 * excludes — state records are always excluded for recall purposes.
 */
export async function tailEntries(
	file: string,
	n: number,
	skip: (entry: SessionEntry) => boolean = () => false,
): Promise<SessionEntry[]> {
	const window: SessionEntry[] = [];
	for await (const entry of streamEntries(file)) {
		if (entry.type === "compaction") {
			window.length = 0; // newest compaction entry wins: history before it is out
			continue;
		}
		if (skip(entry) || isStateRecordEntry(entry)) continue;
		window.push(entry);
		if (window.length > n) window.shift();
	}
	return window;
}

interface ImageLike {
	type: string;
	data?: string;
	mimeType?: string;
}

interface MessageLike {
	role: string;
	content: string | Array<{ type: string; text?: string } & ImageLike & Record<string, unknown>>;
}

function asMessage(entry: SessionEntry): MessageLike | null {
	if (entry.type !== "message") return null;
	return (entry as unknown as { message: MessageLike }).message ?? null;
}

function textBlocks(content: MessageLike["content"]): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string);
}

function imageBlocks(content: MessageLike["content"]): ImageLike[] {
	if (!Array.isArray(content)) return [];
	return content.filter((b) => b.type === "image");
}

/**
 * Stream a session file's entries line by line, skipping the session
 * header. A malformed final line is tolerated (the file may be mid-append);
 * a malformed interior line throws.
 */
export async function* streamEntries(file: string): AsyncGenerator<SessionEntry> {
	const rl = createInterface({
		input: createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});
	let pending: Error | null = null;
	for await (const line of rl) {
		if (!line.trim()) continue;
		if (pending) throw pending; // a further line arrived: the bad one was interior
		let entry: SessionEntry | null = null;
		try {
			entry = JSON.parse(line) as SessionEntry;
		} catch {
			pending = new Error(`malformed session line in ${file}: ${line.slice(0, 60)}`);
			continue;
		}
		if ((entry as unknown as { type: string }).type === "session") continue;
		yield entry;
	}
	// stream ended: a pending failure is a tolerated partial trailing line
}

/** Parse a session file's header; null when the file is missing or unreadable.
 * Reads a bounded prefix — never the whole file. */
export function parseSessionHeader(
	file: string,
): { id: string; cwd: string; parentSession?: string } | null {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buf = Buffer.alloc(65_536);
		const n = readSync(fd, buf, 0, buf.length, 0);
		const first = buf.subarray(0, n).toString("utf8").split("\n", 1)[0];
		if (!first?.trim()) return null;
		const header = JSON.parse(first) as { type: string; id?: string; cwd?: string; parentSession?: string };
		if (header.type !== "session") return null;
		return {
			id: header.id ?? "",
			cwd: header.cwd ?? "",
			...(header.parentSession ? { parentSession: header.parentSession } : {}),
		};
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** True only for this extension's own state records. */
export function isStateRecordEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "custom" &&
		(entry as unknown as { customType?: string }).customType === STATE_RECORD_TYPE
	);
}

export function entryRole(entry: SessionEntry): "user" | "assistant" | "toolResult" | "system" | "other" {
	const message = asMessage(entry);
	if (!message) return "other";
	switch (message.role) {
		case "user":
		case "assistant":
		case "toolResult":
		case "system":
			return message.role;
		default:
			return "other";
	}
}

/** Searchable text of an entry: its text blocks joined. */
export function entrySearchText(entry: SessionEntry): string {
	const message = asMessage(entry);
	if (!message) {
		if (entry.type === "compaction") {
			return (entry as unknown as { summary?: string }).summary ?? "";
		}
		return "";
	}
	return textBlocks(message.content).join("\n");
}

/** Verbatim rendering of an entry for recall_get (images noted, not inlined). */
export function renderEntry(entry: SessionEntry): string {
	const message = asMessage(entry);
	if (!message) {
		if (entry.type === "compaction") {
			const c = entry as unknown as { summary?: string };
			return `[compaction]\n${c.summary ?? ""}`;
		}
		if (entry.type === "custom") {
			const c = entry as unknown as { customType?: string; data?: unknown };
			return `[custom ${c.customType ?? ""}]\n${JSON.stringify(c.data ?? null)}`;
		}
		return JSON.stringify(entry);
	}
	const lines: string[] = [`[${message.role}]`];
	for (const text of textBlocks(message.content)) lines.push(text);
	if (Array.isArray(message.content)) {
		for (const block of message.content) {
			if (block.type === "image") lines.push(`[image: ${block.mimeType ?? "unknown"}, ${block.data?.length ?? 0} bytes]`);
			if (block.type === "toolCall") {
				const call = block as unknown as { name?: string; arguments?: unknown };
				lines.push(`[toolCall ${call.name ?? "?"}(${JSON.stringify(call.arguments ?? {})})]`);
			}
		}
	}
	return lines.join("\n");
}

export function entryImages(entry: SessionEntry): ImageLike[] {
	const message = asMessage(entry);
	if (!message) return [];
	return imageBlocks(message.content);
}

/** First line of a user entry's first text block; null for anything else. */
export function firstUserLine(entry: SessionEntry): string | null {
	const message = asMessage(entry);
	if (!message || message.role !== "user") return null;
	const text = textBlocks(message.content).join("\n");
	if (!text) return null;
	return text.split("\n", 1)[0] ?? null;
}
