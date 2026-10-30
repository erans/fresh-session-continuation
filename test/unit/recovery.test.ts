import { describe, expect, it } from "vitest";
import { createSwitchState } from "../../src/state.js";
import { registerRecovery } from "../../src/recovery.js";
import { NOTICES } from "../../src/notices.js";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const FILE = "/s/x.jsonl";

interface Recorded {
	customType: string;
	data: Record<string, unknown>;
}

function armedRecord(armedAt: number, owner = FILE): Record<string, unknown> {
	return {
		type: "custom",
		id: "r1",
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: "fresh-session-switch",
		data: { state: "armed", owner, oldSessionPath: FILE, pointerTextStatic: "S", armedAt },
	};
}

function makeFakePi(branch: SessionEntry[], mode = "rpc") {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void> | void>>();
	const records: Recorded[] = [];
	const notices: string[] = [];
	const sends: string[] = [];
	const pi = {
		on: (ev: string, h: (event: unknown, ctx: unknown) => Promise<void> | void) => {
			const list = handlers.get(ev) ?? [];
			list.push(h);
			handlers.set(ev, list);
			return () => {};
		},
		appendEntry: (customType: string, data: Record<string, unknown>) => {
			records.push({ customType, data });
		},
		registerCommand: () => {},
		sendUserMessage: (text: string) => {
			sends.push(text);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode,
		sessionManager: {
			getSessionFile: () => FILE,
			getBranch: () => branch,
		},
		ui: { notify: (m: string) => notices.push(m) },
	};
	const emit = async (ev: string, event: unknown) => {
		for (const h of handlers.get(ev) ?? []) await h(event, ctx);
	};
	return { pi, records, notices, sends, emit };
}

describe("session_start recovery", () => {
	it("an expired gate clears the record and emits the degraded notice once", async () => {
		const { pi, records, notices, sends, emit } = makeFakePi([
			armedRecord(Date.now() - 120_000) as unknown as SessionEntry,
		]);
		const st = createSwitchState();
		registerRecovery(pi, st);
		await emit("session_start", { type: "session_start", reason: "resume" });
		expect(sends).toHaveLength(0);
		expect(records).toHaveLength(1);
		expect(records[0].data.state).toBe("cleared");
		expect(notices).toEqual([NOTICES.degraded(undefined)]);
		expect(st.getState()).toBe("idle");
	});

	it("print/json mode clears the record with no notice", async () => {
		const { pi, records, notices, sends, emit } = makeFakePi([armedRecord(Date.now()) as unknown as SessionEntry], "json");
		const st = createSwitchState();
		registerRecovery(pi, st);
		await emit("session_start", { type: "session_start", reason: "resume" });
		expect(sends).toHaveLength(0);
		expect(records).toHaveLength(1);
		expect(records[0].data.state).toBe("cleared");
		expect(notices).toHaveLength(0);
	});

	it("reload re-hydrates armed without dispatching; agent_end then emits the degraded notice once", async () => {
		const { pi, records, notices, sends, emit } = makeFakePi([armedRecord(Date.now()) as unknown as SessionEntry]);
		const st = createSwitchState();
		registerRecovery(pi, st);
		await emit("session_start", { type: "session_start", reason: "reload" });
		expect(st.getState()).toBe("armed");
		expect(sends).toHaveLength(0);
		expect(notices).toHaveLength(0);
		await emit("agent_end", { type: "agent_end" });
		expect(notices).toEqual([NOTICES.degraded(undefined)]);
		expect(records.some((r) => r.data.state === "cleared")).toBe(true);
		expect(st.getState()).toBe("idle");
	});

	it("a fork-copied record (owner mismatch) is a silent no-op", async () => {
		const { pi, records, notices, sends, emit } = makeFakePi([
			armedRecord(Date.now(), "/s/original.jsonl") as unknown as SessionEntry,
		]);
		const st = createSwitchState();
		registerRecovery(pi, st);
		await emit("session_start", { type: "session_start", reason: "resume" });
		expect(sends).toHaveLength(0);
		expect(records).toHaveLength(0);
		expect(notices).toHaveLength(0);
	});

	it("an in-window record re-arms and dispatches exactly one /fresh", async () => {
		const { pi, sends, emit } = makeFakePi([armedRecord(Date.now()) as unknown as SessionEntry]);
		const st = createSwitchState();
		registerRecovery(pi, st);
		await emit("session_start", { type: "session_start", reason: "startup" });
		await new Promise((r) => setTimeout(r, 5));
		expect(sends).toEqual(["/fresh"]);
	});

	it("never-dispatched armed state at agent_end emits the degraded notice once", async () => {
		const { pi, records, notices, emit } = makeFakePi([armedRecord(Date.now()) as unknown as SessionEntry]);
		const st = createSwitchState();
		registerRecovery(pi, st);
		st.arm({ oldSessionPath: FILE, pointerTextStatic: "S" });
		st.setDispatchQueued(false); // the dispatch never ran
		await emit("agent_end", { type: "agent_end" });
		expect(notices).toEqual([NOTICES.degraded(undefined)]);
		expect(records.some((r) => r.data.state === "cleared")).toBe(true);
		expect(st.getState()).toBe("idle");
	});

	it("in-flight never triggers the never-dispatched notice", async () => {
		const { pi, notices, emit } = makeFakePi([armedRecord(Date.now()) as unknown as SessionEntry]);
		const st = createSwitchState();
		registerRecovery(pi, st);
		st.arm({ oldSessionPath: FILE, pointerTextStatic: "S" });
		st.toInFlight();
		await emit("agent_end", { type: "agent_end" });
		expect(notices).toHaveLength(0);
	});
});
