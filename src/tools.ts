import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	entryRole,
	entrySearchText,
	isStateRecordEntry,
	parseSessionHeader,
	renderEntry,
	streamEntries,
	streamEntryLines,
	tailEntries,
} from "./reader.js";
import {
	mintCursor,
	parseCursor,
	RECALL_BUDGET,
	resolveChain,
	shaDigest,
	verifyCursor,
	type ChainBudget,
} from "./chain.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const RESULT_CAP_BYTES = 32_768;
const PER_FILE_FLOOR = 5;
const DEFAULT_LIMIT = 25;
const DEFAULT_TAIL = 20;
const REGEX_QUERY_CAP = 200;
const REGEX_CHUNK_BYTES = 4_096;

/** Full ancestry for validation and cursor digests — header-only, not depth-budgeted. */
const FULL_ANCESTRY_BUDGET: ChainBudget = {
	maxBytes: RECALL_BUDGET.maxBytes,
	maxElapsedMs: 5_000,
	maxDepth: 10_000,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ToolCtxLike {
	sessionManager: {
		getSessionFile: () => string | undefined;
		getSessionDir: () => string;
	};
}

function textResult(text: string, isError = false): AgentToolResult {
	return { content: [{ type: "text", text }], details: undefined, isError };
}

function err(text: string): AgentToolResult {
	return textResult(text, true);
}

interface Hit {
	file: string;
	gen: number;
	label: string;
	entryId: string;
	role: string;
	timestamp: string;
	excerpt: string;
}

function byNewestFirst(a: Hit, b: Hit): number {
	if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
	return a.gen - b.gen; // ties: the newer generation first
}

function excerptAround(text: string, index: number): string {
	const from = Math.max(0, index - 80);
	return text.slice(from, Math.min(text.length, index + 140)).replace(/\n/g, " ");
}

async function fileHasCompaction(file: string): Promise<boolean> {
	for await (const entry of streamEntries(file)) {
		if (entry.type === "compaction") return true;
	}
	return false;
}

/** Resolve the tail target: own compaction entry → header parentSession → current file. */
async function resolveTailTarget(sessionFile: string): Promise<string> {
	if (await fileHasCompaction(sessionFile)) return sessionFile;
	const parent = parseSessionHeader(sessionFile)?.parentSession;
	return parent ?? sessionFile;
}

/** Returns the match index, -1 for no match, -2 for an elapsed budget cut. */
function matchEntry(
	text: string,
	query: string,
	isRegex: boolean,
	elapsedOver: () => boolean,
): number {
	if (!isRegex) return text.indexOf(query);
	const buffer = Buffer.from(text, "utf8");
	for (let off = 0; off < buffer.length; off += REGEX_CHUNK_BYTES) {
		if (elapsedOver()) return -2;
		const chunk = buffer.subarray(off, off + REGEX_CHUNK_BYTES).toString("utf8");
		const at = chunk.search(new RegExp(query));
		if (at >= 0) return off + Buffer.byteLength(chunk.slice(0, at), "utf8");
	}
	return -1;
}

/**
 * `recall` — search the record, review the tail, or continue a cut walk.
 * Targets: the current session file plus its validated parentSession
 * ancestors. `file` is never a free path — it must be a chain member.
 */
export function makeRecallTool(opts: { budget?: ChainBudget } = {}) {
	const budget = opts.budget ?? RECALL_BUDGET;
	return {
		name: "recall",
		label: "Recall session history",
		description:
			"Search the verbatim record of this session and its ancestor sessions. Literal substring search by default. Use tail to review recent steps, or cursor to continue a budget-cut search. Never re-derive what you can recall.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Literal text to find (escaped). Ignored with cursor/tail." })),
			tail: Type.Optional(Type.Number({ description: "Return the last N entries of the pointer-named session." })),
			role: Type.Optional(
				Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("toolResult")], {
					description: "Filter entries by role.",
				}),
			),
			limit: Type.Optional(Type.Number({ description: "Global hit cap across all files." })),
			regex: Type.Optional(Type.Boolean({ description: "Opt in to regex matching for query." })),
			cursor: Type.Optional(Type.String({ description: "Resume a budget-cut search." })),
			file: Type.Optional(Type.String({ description: "Narrow the search to one chain member." })),
		}),
		execute: async (
			_toolCallId: string,
			params: any,
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ToolCtxLike,
		): Promise<AgentToolResult> => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			const sessionDir = ctx.sessionManager.getSessionDir();
			if (!sessionFile) return err("recall: no persisted session file");

			const hasQuery = typeof params.query === "string";
			const hasTail = typeof params.tail === "number";
			const hasCursor = typeof params.cursor === "string";
			const modes = [hasQuery, hasTail, hasCursor].filter(Boolean).length;
			if (modes !== 1) {
				return err("recall: exactly one of query, tail, or cursor is required");
			}
			if (hasCursor && (hasQuery || hasTail || params.file)) {
				return err("recall: cursor resumes its stored query — pass no query, tail, or file");
			}
			if (hasQuery && params.regex && params.query.length > REGEX_QUERY_CAP) {
				return err(`recall: regex queries are capped at ${REGEX_QUERY_CAP} characters`);
			}

			const ancestry = await resolveChain(sessionFile, sessionDir, FULL_ANCESTRY_BUDGET);
			const ancestryFiles = ancestry.targets.map((t) => t.file);
			const digest = shaDigest(ancestryFiles);

			// ---- tail mode ----
			if (hasTail) {
				let target = await resolveTailTarget(sessionFile);
				if (params.file) {
					if (!ancestryFiles.includes(params.file)) {
						return err(`recall: file must be a chain member; valid targets: ${ancestryFiles.join(", ")}`);
					}
					target = params.file;
				}
				const entries = await tailEntries(target, params.tail ?? DEFAULT_TAIL, (e) =>
					params.role ? entryRole(e) !== params.role : false,
				);
				const parts: string[] = [`tail of ${target}:`];
				for (const entry of entries) parts.push(renderEntry(entry));
				let out = parts.join("\n\n");
				if (Buffer.byteLength(out, "utf8") > RESULT_CAP_BYTES) {
					// the replay offset must be relative to the named entry's own
					// render — recall_get replays a single entry from `offset`
					const cut = RESULT_CAP_BYTES - 300;
					let replay: { entryId: string; offset: number } | null = null;
					// positions: parts[0] is the header, then one part per entry
					let cursorPos = Buffer.byteLength(parts[0] + "\n\n", "utf8");
					for (let i = 0; i < entries.length; i++) {
						const len = Buffer.byteLength(parts[i + 1], "utf8");
						if (cut < cursorPos + len) {
							replay = { entryId: (entries[i] as { id: string }).id, offset: Math.max(0, cut - cursorPos) };
							break;
						}
						cursorPos += len + 2; // the "\n\n" joiner
					}
					if (!replay) {
						replay = {
							entryId: (entries[entries.length - 1] as { id: string } | undefined)?.id ?? "",
							offset: 0,
						};
					}
					out = `${Buffer.from(out, "utf8").subarray(0, cut).toString("utf8")}\n[truncated]\nnext: { "file": "${target}", "entryId": "${replay.entryId}", "offset": ${replay.offset} }`;
				}
				return textResult(out);
			}

			// ---- resolve the query and the resume point ----
			let query: string;
			let isRegex: boolean;
			let roleFilter: string | undefined;
			let limit: number;
			let chainIndex = 0;
			if (hasCursor) {
				const cursor = parseCursor(params.cursor);
				if (!cursor) return err("recall: malformed cursor");
				if (!verifyCursor(cursor, digest)) {
					return err("recall: ancestor chain invalid — the cursor does not match the resolved chain");
				}
				query = cursor.query;
				isRegex = cursor.regex === true; // the cursor preserves its search's mode
				roleFilter = params.role;
				limit = params.limit ?? DEFAULT_LIMIT;
				chainIndex = cursor.chainIndex;
			} else {
				query = params.query;
				isRegex = params.regex === true;
				roleFilter = params.role;
				limit = params.limit ?? DEFAULT_LIMIT;
			}

			// ---- search mode ----
			let scanFiles = ancestryFiles;
			if (params.file) {
				if (!ancestryFiles.includes(params.file)) {
					return err(`recall: file must be a chain member; valid targets: ${ancestryFiles.join(", ")}`);
				}
				scanFiles = [params.file];
			}

			// a cursor call resumes the walk at the cursor's file: a fresh depth
			// budget per call, so continuation reaches past one walk's depth
			const resumeFrom = hasCursor
				? scanFiles[Math.max(0, Math.min(chainIndex, scanFiles.length - 1))]
				: sessionFile;
			const walk = await resolveChain(resumeFrom, sessionDir, budget);
			const walkFiles = walk.targets.map((t) => t.file);
			const startAt = Math.max(0, Math.min(chainIndex, scanFiles.length - 1));
			const filesToScan = scanFiles.filter(
				(f, i) => i >= startAt && (walkFiles.includes(f) || params.file),
			);

			const start = Date.now();
			const elapsedOver = () => Date.now() - start > budget.maxElapsedMs;
			const hitsByFile = new Map<string, Hit[]>();
			const scanned: string[] = [];
			const unscanned: string[] = [];
			let bytes = 0;
			let cutAt: { file: string } | null = null;
			let cutByteOffset = 0; // bytes scanned into the cut file: the resume skips them
			const resumeByteOffset = hasCursor ? Math.max(0, parseCursor(params.cursor)?.byteOffset ?? 0) : 0;

			for (const file of filesToScan) {
				if (elapsedOver() || bytes > budget.maxBytes) {
					cutAt = { file };
					cutByteOffset = 0;
					unscanned.push(file);
					continue;
				}
				let fileBytes = 0;
				// a cursor resuming this file skips its already-scanned prefix
				const skipBytes = hasCursor && file === scanFiles[startAt] ? resumeByteOffset : 0;
				if (skipBytes > 0) fileBytes = skipBytes;
				try {
					for await (const { entry, lineBytes } of streamEntryLines(file, skipBytes)) {
						fileBytes += lineBytes;
						bytes += lineBytes;
						if (bytes > budget.maxBytes || elapsedOver()) {
							cutAt = { file };
							cutByteOffset = fileBytes;
							break;
						}
						if (isStateRecordEntry(entry)) continue;
						const role = entryRole(entry);
						if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
						if (roleFilter && role !== roleFilter) continue;
						const text = entrySearchText(entry);
						if (!text) continue;
						const at = matchEntry(text, query, isRegex, elapsedOver);
						if (at === -2) {
							cutAt = { file };
							cutByteOffset = fileBytes;
							break;
						}
						if (at >= 0) {
							const list = hitsByFile.get(file) ?? [];
							list.push({
								file,
								gen: ancestryFiles.indexOf(file),
								label: `gen${ancestryFiles.indexOf(file)}`,
								entryId: entry.id,
								role,
								timestamp: entry.timestamp,
								excerpt: excerptAround(text, at),
							});
							hitsByFile.set(file, list);
						}
					}
					if (!cutAt || cutAt.file !== file) scanned.push(file);
					else unscanned.push(file);
				} catch {
					unscanned.push(file);
				}
			}
			for (const file of filesToScan) {
				if (!scanned.includes(file) && !unscanned.includes(file)) unscanned.push(file);
			}
			if (walk.reason && walk.stoppedAt && !unscanned.includes(walk.stoppedAt)) {
				unscanned.push(`${walk.stoppedAt} (beyond walk: ${walk.reason})`);
				// a budget stop is resumable: the cursor restarts the walk at the
				// stopped file with a fresh per-call budget (invalid/cycle stops are not)
				if (walk.reason === "budget" && !cutAt && ancestryFiles.includes(walk.stoppedAt)) {
					cutAt = { file: walk.stoppedAt };
				}
			}

			// newest-first interleave with a per-file floor while the limit is unspent
			const selected: Hit[] = [];
			const remainingByFile = new Map(hitsByFile);
			for (const file of filesToScan) {
				const list = remainingByFile.get(file);
				if (!list?.length) continue;
				const take = Math.min(PER_FILE_FLOOR, list.length, limit - selected.length);
				if (take <= 0) continue;
				selected.push(...list.slice(0, take));
				if (take < list.length) remainingByFile.set(file, list.slice(take));
				else remainingByFile.delete(file);
			}
			const leftovers = [...remainingByFile.values()].flat();
			leftovers.sort(byNewestFirst);
			for (const hit of leftovers) {
				if (selected.length >= limit) break;
				selected.push(hit);
			}
			selected.sort(byNewestFirst);

			const lines: string[] = [];
			if (selected.length === 0) lines.push(`no hits for: ${query}`);
			for (const hit of selected) {
				lines.push(`- [${hit.entryId}@${hit.label}] (${hit.role}, ${hit.timestamp}) ${hit.excerpt}`);
			}
			if (cutAt) {
				const nextCursor = mintCursor({
					visitedDigest: digest,
					chainIndex: Math.max(0, ancestryFiles.indexOf(cutAt.file)),
					byteOffset: cutByteOffset,
					query,
					regex: isRegex || undefined,
				});
				lines.push(
					`not scanned this call: ${unscanned.join(", ") || "(none)"} — narrow the query, or continue with the cursor below`,
				);
				lines.push(`nextCursor: ${nextCursor}`);
			} else if (unscanned.length > 0) {
				lines.push(`not scanned this call: ${unscanned.join(", ")}`);
			}

			let out = lines.join("\n");
			if (Buffer.byteLength(out, "utf8") > RESULT_CAP_BYTES) {
				out = `${Buffer.from(out, "utf8").subarray(0, RESULT_CAP_BYTES - 16).toString("utf8")}\n[truncated]`;
			}
			return textResult(out);
		},
	};
}

/**
 * `recall_get` — fetch entries verbatim. The `file` argument is never a
 * free path: it must exactly match the current session or one of its fully
 * resolved ancestors (header-only validation, not depth-budgeted).
 */
export function makeRecallGetTool() {
	return {
		name: "recall_get",
		label: "Fetch session entries verbatim",
		description:
			"Fetch the exact, verbatim content of one entry (or a window around it) from the session record. Page truncated fetches with the returned next offset.",
		parameters: Type.Object({
			file: Type.Optional(Type.String({ description: "Chain member file the entry lives in." })),
			entryId: Type.Optional(Type.String({ description: "Entry id (unique within one file)." })),
			offset: Type.Optional(Type.Number({ description: "UTF-8 byte offset to continue a truncated fetch." })),
			around: Type.Optional(
				Type.Object({
					file: Type.String(),
					entryId: Type.String(),
					before: Type.Number({ description: "Entries before the target." }),
					after: Type.Number({ description: "Entries after the target." }),
				}),
			),
		}),
		execute: async (
			_toolCallId: string,
			params: any,
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ToolCtxLike,
		): Promise<AgentToolResult> => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			const sessionDir = ctx.sessionManager.getSessionDir();
			if (!sessionFile) return err("recall_get: no persisted session file");

			const around = params.around as
				| { file: string; entryId: string; before: number; after: number }
				| undefined;
			const file: string | undefined = around?.file ?? params.file;
			const entryId: string | undefined = around?.entryId ?? params.entryId;
			if (!file || !entryId) {
				return err(
					"recall_get: provide { file, entryId } or { around: { file, entryId, before, after } }",
				);
			}

			const ancestry = await resolveChain(sessionFile, sessionDir, FULL_ANCESTRY_BUDGET);
			const valid = ancestry.targets.map((t) => t.file);
			if (file !== sessionFile && !valid.includes(file)) {
				return err(
					`recall_get: file must be the current session or an ancestor; valid targets: ${valid.join(", ")}`,
				);
			}

			const offset = typeof params.offset === "number" ? params.offset : 0;
			let rendered = "";
			let matched = false;

			if (around) {
				const before: SessionEntry[] = [];
				const after: SessionEntry[] = [];
				let target: SessionEntry | null = null;
				for await (const entry of streamEntries(file) as AsyncGenerator<SessionEntry>) {
					if (isStateRecordEntry(entry)) continue;
					if (target === null) {
						if (entry.id === entryId) {
							target = entry;
							continue;
						}
						before.push(entry);
						if (before.length > around.before) before.shift();
					} else {
						after.push(entry);
						if (after.length >= around.after) break;
					}
				}
				if (!target) return err(`recall_get: entry ${entryId} not found in ${file}`);
				rendered = [...before, target, ...after].map((e) => renderEntry(e)).join("\n\n");
				matched = true;
			} else {
				for await (const entry of streamEntries(file) as AsyncGenerator<SessionEntry>) {
					if (entry.id === entryId) {
						rendered = renderEntry(entry);
						matched = true;
						break;
					}
				}
			}
			if (!matched) return err(`recall_get: entry ${entryId} not found in ${file}`);

			const buffer = Buffer.from(rendered, "utf8");
			const from = Math.min(offset, buffer.length);
			let out: string;
			if (buffer.length - from > RESULT_CAP_BYTES) {
				const nextOffset = from + RESULT_CAP_BYTES - 300;
				out = `${buffer.subarray(from, from + RESULT_CAP_BYTES - 300).toString("utf8")}\n[truncated]\nnext: { "file": "${file}", "entryId": "${entryId}", "offset": ${nextOffset} }`;
			} else {
				out = buffer.subarray(from).toString("utf8");
			}
			return textResult(out);
		},
	};
}
