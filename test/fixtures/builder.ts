import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Programmatic session-file fixture builder. Entries are appended in call
 * order; parentId defaults to the previous entry (linear), or set it
 * explicitly for branches.
 */
export interface BuilderOptions {
	cwd?: string;
	parentSession?: string;
}

export class SessionBuilder {
	private entries: Record<string, unknown>[] = [];
	private lastId: string | null = null;

	constructor(
		private readonly dir: string,
		private readonly name: string,
		private readonly opts: BuilderOptions = {},
	) {}

	private nextParent(explicit?: string | null): string | null {
		return explicit === undefined ? this.lastId : explicit;
	}

	user(id: string, text: string | unknown[], parentId?: string | null): this {
		const content =
			typeof text === "string"
				? text
				: (text as { type: string; [k: string]: unknown }[]);
		this.entries.push({
			type: "message",
			id,
			parentId: this.nextParent(parentId),
			timestamp: new Date().toISOString(),
			message: { role: "user", content, timestamp: Date.now() },
		});
		this.lastId = id;
		return this;
	}

	assistant(id: string, text: string, parentId?: string | null): this {
		this.entries.push({
			type: "message",
			id,
			parentId: this.nextParent(parentId),
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "fake-stream",
				provider: "fake",
				model: "fake-1",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});
		this.lastId = id;
		return this;
	}

	toolResult(
		id: string,
		toolCallId: string,
		toolName: string,
		text: string,
		parentId?: string | null,
	): this {
		this.entries.push({
			type: "message",
			id,
			parentId: this.nextParent(parentId),
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text }],
				isError: false,
				timestamp: Date.now(),
			},
		});
		this.lastId = id;
		return this;
	}

	compaction(
		id: string,
		fields: { summary: string; firstKeptEntryId: string | null; tokensBefore: number },
		parentId?: string | null,
	): this {
		this.entries.push({
			type: "compaction",
			id,
			parentId: this.nextParent(parentId),
			timestamp: new Date().toISOString(),
			...fields,
		});
		this.lastId = id;
		return this;
	}

	custom(id: string, customType: string, data: unknown, parentId?: string | null): this {
		this.entries.push({
			type: "custom",
			id,
			parentId: this.nextParent(parentId),
			timestamp: new Date().toISOString(),
			customType,
			data,
		});
		this.lastId = id;
		return this;
	}

	raw(entry: Record<string, unknown>): this {
		this.entries.push(entry);
		if (typeof entry.id === "string") this.lastId = entry.id as string;
		return this;
	}

	write(): string {
		mkdirSync(this.dir, { recursive: true });
		const path = join(this.dir, this.name);
		const header = {
			type: "session",
			version: 3,
			id: this.name.replace(/\.jsonl$/, ""),
			timestamp: new Date().toISOString(),
			cwd: this.opts.cwd ?? this.dir,
			...(this.opts.parentSession ? { parentSession: this.opts.parentSession } : {}),
		};
		const lines = [JSON.stringify(header), ...this.entries.map((e) => JSON.stringify(e))];
		writeFileSync(path, `${lines.join("\n")}\n`);
		return path;
	}
}

export function buildSession(dir: string, name: string, opts?: BuilderOptions): SessionBuilder {
	return new SessionBuilder(dir, name, opts);
}
