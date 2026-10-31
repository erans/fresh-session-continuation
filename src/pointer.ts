import { basename } from "node:path";
import { POINTER_BUDGET } from "./chain.js";
import { firstUserLine } from "./reader.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const POINTER_CAP_BYTES = 16_384;
export const VOLATILE_HEADROOM_BYTES = 4_096;
const STATIC_TARGET_BYTES = POINTER_CAP_BYTES - VOLATILE_HEADROOM_BYTES;

export interface TocEntry {
	file: string;
	entryId: string;
	line: string;
	timestamp: string;
}

export interface TocFileInput {
	file: string;
	entries: SessionEntry[];
}

export interface StaticInput {
	oldSessionPath: string;
	toc: TocEntry[];
	readFiles: string[];
	modifiedFiles: string[];
	/** chain members the TOC walk could not index (budget stop) — named loudly */
	exhaustedAfter?: string[];
}

export interface Anchor {
	lastAssistantText: string;
	entryRefs: { file: string; entryId: string }[];
	boundaryEntryId?: string;
}

export interface VolatileInput {
	lastUserMessage: string;
	images: { type: "image"; data: string; mimeType: string }[];
	anchor: Anchor;
}

const INSTRUCTIONS =
	"Do not re-ask the user. When you need the exact error message, file path, number, or prior decision, search the record with `recall` instead of re-deriving — if a search reports unscanned files, continue it with the returned cursor.";

const SELF_SUFFICIENCY =
	"If the `recall` tool is not available (extension disabled), read the session file directly with the read/bash tools.";

const ABANDONED_BRANCHES =
	"The index covers the main line; recall also searches abandoned attempts.";

function bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * The static pointer part. The cap is a property of this function: every
 * call applies the same truncation (TOC entries first, then file lists;
 * the old session path and the instructions are never truncated) and
 * reserves the same volatile headroom against the ~16 KB target.
 */
export function renderPointerStatic(input: StaticInput): string {
	const header = `Previous session (complete, verbatim record): ${input.oldSessionPath}\n\n`;

	// Build the TOC section, dropping entries from the end until the whole
	// render fits the static target; a drop leaves the terminal marker.
	const tocLines = input.toc.map(
		(t) => `- [${t.entryId}] ${t.line}  (${t.timestamp.slice(0, 19)})`,
	);
	const fileSection = (title: string, files: string[]) =>
		files.length ? `\n${title}:\n${files.map((f) => `- ${f}`).join("\n")}\n` : "";
	const tail = `\n## Instructions\n${INSTRUCTIONS}\n\n${ABANDONED_BRANCHES}\n\n${SELF_SUFFICIENCY}\n`;

	// M2: chain members the walk could not index are named, never silent
	const exhaustedMarker = (input.exhaustedAfter?.length ?? 0) > 0
		? [
				`- older sessions not indexed here: ${(input.exhaustedAfter ?? []).map((f) => basename(f)).join(", ")} — search them with recall, which continues past its budget via cursor`,
			]
		: [];

	// Budget the TOC: the fixed parts are untouchable, the TOC shrinks first,
	// then the file lists truncate (first N + a loud remainder marker).
	const marker = (dropped: number) =>
		dropped > 0
			? [`- older sessions not indexed here: ${dropped} entr${dropped === 1 ? "y" : "ies"} dropped to fit the pointer cap — search them with recall, which continues past its budget via cursor\n`]
			: [];
	const truncatedFileSection = (title: string, files2: string[]) => {
		const rendered = fileSection(title, files2);
		if (bytes(rendered) === 0) return () => rendered;
		return (keep: number) =>
			keep >= files2.length
				? rendered
				: `${fileSection(title, files2.slice(0, keep))}\n${files2.length - keep} more not listed — recall the record for them\n`;
	};
	const readFilesRender = truncatedFileSection("Files read", input.readFiles);
	const modifiedFilesRender = truncatedFileSection("Files modified", input.modifiedFiles);
	let drop = 0;
	let keepRead = input.readFiles.length;
	let keepModified = input.modifiedFiles.length;
	let toc: string;
	let filesOut: string;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		toc = `\n## Index of user messages\n${[
			...tocLines.slice(0, tocLines.length - drop),
			...exhaustedMarker,
			...marker(drop),
		].join("\n")}\n`;
		filesOut = readFilesRender(keepRead) + modifiedFilesRender(keepModified);
		const total = bytes(header + toc + filesOut + tail);
		if (total <= STATIC_TARGET_BYTES) break;
		if (drop < tocLines.length) {
			drop++;
			continue;
		}
		// TOC exhausted: truncate the file lists one entry at a time
		if (keepRead > 0) {
			keepRead--;
			continue;
		}
		if (keepModified > 0) {
			keepModified--;
			continue;
		}
		break; // only the path and instructions remain: never truncated
	}
	return header + toc + filesOut + tail;
}

/**
 * The volatile block. Never persisted; rebuilt from the branch at each
 * assembly. Capped against the static headroom: anchor excerpt first,
 * then the last user message (with the oversized rule).
 */
export function renderVolatileBlock(input: VolatileInput): string {
	const lines: string[] = ["You were mid-task; resume this."];

	const messageBudget = VOLATILE_HEADROOM_BYTES - 1024; // leave room for the anchor
	const message =
		bytes(input.lastUserMessage) > messageBudget
			? `${input.lastUserMessage.slice(0, messageBudget)}…[truncated — verbatim text via recall { tail }]`
			: input.lastUserMessage;
	lines.push(`Last user message: ${message}`);

	if (input.images.length > 0) {
		lines.push(`(${input.images.length} image(s) from the last message are attached)`);
	}

	const anchorText =
		bytes(input.anchor.lastAssistantText) > 1024
			? `${input.anchor.lastAssistantText.slice(0, 1024)}…[truncated]`
			: input.anchor.lastAssistantText;
	lines.push(`Last assistant progress: ${anchorText}`);
	const refs = input.anchor.entryRefs.map((r) => `${r.entryId}@${r.file}`).join(", ");
	lines.push(
		`Your most recent steps are entries ${refs} — recall_get them before re-doing work`,
	);
	if (input.anchor.boundaryEntryId) {
		lines.push(`entries after ${input.anchor.boundaryEntryId} are a partial aborted reply`);
	}
	return lines.join("\n");
}

export function assemblePrompt(staticText: string, volatileBlock: string): string {
	return `${staticText}\n${volatileBlock}`;
}

/** Cap re-attached images: last-user-message images only, ~4 count / ~1 MB total. */
export function capImages(images: { type: "image"; data: string; mimeType: string }[]): {
	kept: { type: "image"; data: string; mimeType: string }[];
	dropped: number;
} {
	const kept: typeof images = [];
	let total = 0;
	for (const image of images) {
		if (kept.length >= 4 || total + image.data.length > 1_048_576) {
			return { kept, dropped: images.length - kept.length };
		}
		kept.push(image);
		total += image.data.length;
	}
	return { kept, dropped: 0 };
}

/** TOC entries from each file's entries; a maxTocEntries cut reports the exhausted files. */
export function buildTocFromFiles(
	files: TocFileInput[],
	budget: { maxTocEntries: number },
): { toc: TocEntry[]; exhaustedAfter: string[] } {
	// firstUserLine imported at top: reader does not import pointer (no cycle)
	const toc: TocEntry[] = [];
	const exhaustedAfter: string[] = [];
	for (const { file, entries } of files) {
		let added = 0;
		for (const entry of entries) {
			const line = firstUserLine(entry);
			if (!line) continue;
			if (toc.length >= budget.maxTocEntries) {
				if (!exhaustedAfter.includes(file)) exhaustedAfter.push(file);
				continue;
			}
			toc.push({
				file,
				entryId: entry.id,
				line,
				timestamp: entry.timestamp,
			});
			added++;
		}
		if (added === 0 && entries.length > 0 && toc.length >= budget.maxTocEntries) {
			if (!exhaustedAfter.includes(file)) exhaustedAfter.push(file);
		}
	}
	return { toc, exhaustedAfter };
}

/** Fallback pointer from data already in hand — used when the full render fails. */
export function minimalPointer(oldSessionPath: string, lastUserMessage: string): string {
	return [
		`Previous session (complete, verbatim record): ${oldSessionPath}`,
		"",
		`Last user message: ${lastUserMessage}`,
		"",
		INSTRUCTIONS,
		SELF_SUFFICIENCY,
	].join("\n");
}

export { POINTER_BUDGET };
