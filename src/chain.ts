import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { sep } from "node:path";
import { parseSessionHeader } from "./reader.js";

export interface ChainTarget {
	file: string;
	label: string;
}

export interface ChainBudget {
	maxBytes: number;
	maxElapsedMs: number;
	maxDepth: number;
}

export const POINTER_BUDGET: ChainBudget = { maxBytes: 10_485_760, maxElapsedMs: 2_000, maxDepth: 8 };
export const RECALL_BUDGET: ChainBudget = { maxBytes: 52_428_800, maxElapsedMs: 10_000, maxDepth: 8 };

export interface ChainResult {
	targets: ChainTarget[];
	stoppedAt?: string;
	reason?: "invalid" | "cycle" | "budget";
}

export interface CursorState {
	visitedDigest: string;
	chainIndex: number;
	byteOffset: number;
	query: string;
	/** the search that produced this cursor was a regex search */
	regex?: boolean;
}

function insideDir(dir: string, path: string): boolean {
	try {
		const rp = realpathSync(path);
		const rd = realpathSync(dir);
		return rp === rd || rp.startsWith(rd + sep);
	} catch {
		return false;
	}
}

/**
 * Resolve the current session file plus its parentSession ancestors,
 * newest→oldest, with header-only validation (exists, parses as a session,
 * inside the session dir), a visited set of realpaths (cycle stop), and
 * byte/elapsed/depth budgets. Budget cuts are reported, never silent.
 */
export async function resolveChain(
	sessionFile: string,
	sessionDir: string,
	budget: ChainBudget,
): Promise<ChainResult> {
	const start = Date.now();
	const targets: ChainTarget[] = [{ file: sessionFile, label: "gen0" }];
	const visited = new Set<string>([realpathSync(sessionFile)]);
	let bytes = 0;
	let current = sessionFile;

	for (let depth = 1; depth < budget.maxDepth; depth++) {
		if (Date.now() - start > budget.maxElapsedMs) {
			return { targets, stoppedAt: current, reason: "budget" };
		}
		const header = parseSessionHeader(current);
		bytes += 65_536; // conservative: the bounded header read
		if (bytes > budget.maxBytes) {
			return { targets, stoppedAt: current, reason: "budget" };
		}
		const parent = header?.parentSession;
		if (!parent) return { targets };

		if (!existsSync(parent)) return { targets, stoppedAt: parent, reason: "invalid" };
		if (!insideDir(sessionDir, parent)) return { targets, stoppedAt: parent, reason: "invalid" };
		if (!parseSessionHeader(parent)) return { targets, stoppedAt: parent, reason: "invalid" };

		let rp: string;
		try {
			rp = realpathSync(parent);
		} catch {
			return { targets, stoppedAt: parent, reason: "invalid" };
		}
		if (visited.has(rp)) return { targets, stoppedAt: parent, reason: "cycle" };
		visited.add(rp);

		targets.push({ file: parent, label: `gen${depth}` });
		current = parent;
	}
	// depth budget exhausted: the cut is the next unvisited ancestor
	const nextParent = parseSessionHeader(current)?.parentSession;
	return { targets, stoppedAt: nextParent ?? current, reason: "budget" };
}

/** Stable digest of the visited set, embedded in cursors. */
export function shaDigest(paths: string[]): string {
	return createHash("sha256").update(paths.join("\n")).digest("hex").slice(0, 16);
}

export function mintCursor(state: CursorState): string {
	return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

export function parseCursor(encoded: string): CursorState | null {
	try {
		const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CursorState;
		if (
			typeof parsed.visitedDigest !== "string" ||
			typeof parsed.chainIndex !== "number" ||
			typeof parsed.byteOffset !== "number" ||
			typeof parsed.query !== "string"
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export function verifyCursor(cursor: CursorState, currentDigest: string): boolean {
	return cursor.visitedDigest === currentDigest;
}
