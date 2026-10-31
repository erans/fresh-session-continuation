import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { NOTICES } from "./notices.js";
import {
	assemblePrompt,
	buildTocFromFiles,
	capImages,
	renderPointerStatic,
	renderVolatileBlock,
	type Anchor,
	type VolatileInput,
} from "./pointer.js";
import { appendStateRecord, type SwitchStateInstance } from "./state.js";
import { parseSessionHeader } from "./reader.js";

/**
 * The last-step guard, run immediately before newSession on every path:
 * cancelled → one notice, machine to idle; inactive runtime → silent abort.
 * Exported for unit tests.
 */
export function lastStepGuard(st: SwitchStateInstance, notify: (m: string) => void): boolean {
	if (st.getCancelled()) {
		notify(NOTICES.treeCancelled());
		st.clearCancelled();
		st.toIdle();
		return false;
	}
	if (!st.isActive()) {
		st.toIdle();
		return false;
	}
	return true;
}

interface BranchLikeCtx {
	sessionManager: {
		getBranch: () => SessionEntry[];
		getSessionFile?: () => string | undefined;
	};
	signal?: AbortSignal | undefined;
}

function messageOf(entry: SessionEntry): { role: string; content: unknown } | null {
	if (entry.type !== "message") return null;
	return (entry as unknown as { message?: { role: string; content: unknown } }).message ?? null;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as { type: string; text?: string }[])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

function imagesOf(content: unknown): { type: "image"; data: string; mimeType: string }[] {
	if (!Array.isArray(content)) return [];
	return (content as { type: string; data?: string; mimeType?: string }[])
		.filter((b) => b.type === "image" && typeof b.data === "string")
		.map((b) => ({ type: "image" as const, data: b.data as string, mimeType: b.mimeType ?? "image/png" }));
}

/**
 * Capture the volatile-block inputs from the persisted branch, at each
 * assembly. While streaming with no user entry as the branch tail (the
 * pre-prompt race), poll briefly for the newest prompt; on expiry fall
 * back to the pre-trigger message with the newestPrompt notice.
 */
export async function captureBranchSnapshot(
	ctx: BranchLikeCtx,
	pollMs = 250,
): Promise<{ volatile: VolatileInput; notice?: string }> {
	const read = () => {
		const branch = ctx.sessionManager.getBranch();
		let lastUser: { text: string; images: { type: "image"; data: string; mimeType: string }[] } | null = null;
		let lastAssistant: SessionEntry | null = null;
		for (let i = branch.length - 1; i >= 0; i--) {
			const message = messageOf(branch[i]);
			if (!message) continue;
			if (message.role === "user" && lastUser === null) {
				lastUser = { text: textOf(message.content), images: imagesOf(message.content) };
			}
			if (message.role === "assistant" && !lastAssistant) lastAssistant = branch[i];
			if (lastUser && lastAssistant) break;
		}
		const tail = branch[branch.length - 1] ?? null;
		const tailIsUser = tail !== null && messageOf(tail)?.role === "user";
		return { branch, lastUser, lastAssistant, tailIsUser };
	};

	let { lastUser, lastAssistant, tailIsUser } = read();
	let notice: string | undefined;

	if (ctx.signal !== undefined && !tailIsUser) {
		// a newest prompt is expected: bounded poll
		const deadline = Date.now() + pollMs;
		let latest = lastUser;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 25));
			const next = read();
			if (next.tailIsUser) {
				latest = next.lastUser;
				lastAssistant = next.lastAssistant;
				break;
			}
		}
		if (!latest || !read().tailIsUser) {
			notice = NOTICES.newestPrompt();
		}
		lastUser = latest;
	}

	const assistantText = lastAssistant ? textOf(messageOf(lastAssistant)?.content) : "";
	const anchorFile = ctx.sessionManager.getSessionFile?.() ?? "";
	const anchor: Anchor = {
		lastAssistantText: assistantText,
		// the ids AND file, per spec: the refs are directly recall_get-replayable
		entryRefs: lastAssistant
			? [{ file: anchorFile, entryId: (lastAssistant as unknown as { id: string }).id }]
			: [],
	};
	return {
		volatile: {
			lastUserMessage: lastUser?.text ?? "",
			images: lastUser?.images ?? [],
			anchor,
		},
		notice,
	};
}

/** Assemble the /fresh prompt's static part by mode: armed payload, recovery record, or manual regeneration. */
async function staticForSwitch(
	ctx: ExtensionCommandContext,
	st: SwitchStateInstance,
	oldSessionPath: string,
): Promise<string> {
	const payload = st.getPayload();
	if (payload?.pointerTextStatic) return payload.pointerTextStatic; // latest in-memory render
	// manual invocation with no armed payload: regenerate without file lists
	const tocFiles = [{ file: oldSessionPath, entries: ctx.sessionManager.getBranch() }];
	const { toc } = buildTocFromFiles(tocFiles, { maxTocEntries: 200 });
	return renderPointerStatic({ oldSessionPath, toc, readFiles: [], modifiedFiles: [] });
}

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
			st.setParkedFresh(true);
			try {
				// queued-input drain: deliver and persist before the switch
				if (ctx.hasPendingMessages()) {
					await ctx.waitForIdle();
					if (ctx.hasPendingMessages()) {
						ctx.ui.notify(NOTICES.inputLost()); // residual race window
					}
				}

				const payload = st.getPayload();
				const oldSessionPath = payload?.oldSessionPath ?? ctx.sessionManager.getSessionFile();
				if (!oldSessionPath) {
					ctx.ui.notify(NOTICES.preflight("no session file"));
					st.toIdle();
					return;
				}

				// pre-flight: filesystem + model
				let failure: string | null = null;
				try {
					if (!existsSync(oldSessionPath)) failure = "old session file readable";
					else readFileSync(oldSessionPath).subarray(0, 1);
				} catch {
					failure = "old session file readable";
				}
				if (!failure && !parseSessionHeader(oldSessionPath)) {
					failure = "old session parses as a session file";
				}
				if (!failure) {
					try {
						const { accessSync, constants } = await import("node:fs");
						accessSync(dirname(oldSessionPath), constants.W_OK);
					} catch {
						failure = "session directory writable";
					}
				}
				if (!failure && !ctx.model) failure = "a model is selected";
				if (failure) {
					if (payload) appendStateRecord(pi, { state: "cleared", owner: oldSessionPath, oldSessionPath, pointerTextStatic: payload.pointerTextStatic, armedAt: Date.now() });
					ctx.ui.notify(NOTICES.preflight(failure));
					st.toIdle();
					return;
				}

				// snapshot + assembly
				const snapshot = await captureBranchSnapshot(ctx as unknown as BranchLikeCtx);
				if (snapshot.notice) ctx.ui.notify(snapshot.notice);
				const images = capImages(snapshot.volatile.images);
				if (images.dropped > 0) ctx.ui.notify(NOTICES.imagesCapped(images.kept.length));
				const staticText = await staticForSwitch(ctx, st, oldSessionPath);
				const prompt = assemblePrompt(
					staticText,
					renderVolatileBlock({ ...snapshot.volatile, images: images.kept }),
				);

				// last-step guard, then the commit point: clearing the record
				// immediately before newSession is the only clearing past this point
				if (!lastStepGuard(st, (m) => ctx.ui.notify(m))) return;
				if (payload) {
					appendStateRecord(pi, {
						state: "cleared",
						owner: oldSessionPath,
						oldSessionPath,
						pointerTextStatic: payload.pointerTextStatic,
						armedAt: Date.now(),
					});
				}

				let result: Awaited<ReturnType<typeof ctx.newSession>>;
				try {
					result = await ctx.newSession({
						parentSession: oldSessionPath,
						withSession: async (rc) => {
						const newFile = rc.sessionManager.getSessionFile();
						if (newFile) rc.ui.notify(NOTICES.switch(newFile, oldSessionPath));
						try {
							await rc.sendUserMessage(prompt);
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							rc.ui.notify(NOTICES.continuationFailed(message));
							return;
						}
							// a provider error resolves the turn instead of rejecting: scan its outcome
							const branch = rc.sessionManager.getBranch();
							for (let i = branch.length - 1; i >= 0; i--) {
								const entry = branch[i];
								if (entry.type !== "message") continue;
								const msg = (entry as unknown as { message?: { role: string; stopReason?: string; errorMessage?: string } }).message;
								if (msg?.role !== "assistant") continue;
								if (msg.stopReason === "error") {
									rc.ui.notify(NOTICES.continuationFailed(msg.errorMessage ?? "first turn failed"));
								}
								break;
							}
						},
					});
				} catch (error) {
					// a pre-teardown throw must not escape the command handler:
					// notify and stay on pointer mode
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(NOTICES.degraded(message));
					return;
				}

				if (result.cancelled) {
					// no replacement happened; the record was already cleared at the commit point
					ctx.ui.notify(NOTICES.switchCancelled());
				}
			} finally {
				st.setParkedFresh(false);
				st.toIdle();
			}
		},
	});
}
