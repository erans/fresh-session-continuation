import { describe, expect, it } from "vitest";
import { createSwitchState } from "../../src/state.js";
import { queueDispatch } from "../../src/hook.js";
import { registerTreeHandler } from "../../src/recovery.js";
import { lastStepGuard } from "../../src/fresh.js";
import { NOTICES } from "../../src/notices.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Recorded {
	customType: string;
	data: Record<string, unknown>;
}

function makeFakePi() {
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
		mode: "rpc",
		sessionManager: {
			getSessionFile: () => "/s/x.jsonl",
			getBranch: () => [] as never[],
		},
		ui: { notify: (m: string) => notices.push(m) },
	};
	const emit = async (ev: string, event: unknown) => {
		for (const h of handlers.get(ev) ?? []) await h(event, ctx);
	};
	return { pi, records, notices, sends, ctx, emit };
}

const payload = { oldSessionPath: "/s/x.jsonl", pointerTextStatic: "S" };

describe("session_tree cancellation", () => {
	it("an idle /tree is a plain no-op", async () => {
		const { pi, records, notices, emit } = makeFakePi();
		const st = createSwitchState();
		registerTreeHandler(pi, st);
		await emit("session_tree", { type: "session_tree" });
		expect(st.getCancelled()).toBe(false);
		expect(records).toHaveLength(0);
		expect(notices).toHaveLength(0);
	});

	it("armed + queued dispatch: the handler sets flag and record; the consumer emits and idles", async () => {
		const { pi, records, notices, sends, emit } = makeFakePi();
		const st = createSwitchState();
		registerTreeHandler(pi, st);
		st.arm(payload);
		queueDispatch(pi, st, (m) => notices.push(m)); // sets dispatchQueued
		await emit("session_tree", { type: "session_tree" });
		expect(st.getCancelled()).toBe(true);
		expect(records).toHaveLength(1);
		expect(records[0].data.state).toBe("cleared");
		expect(notices).toHaveLength(0); // the consumer emits, not the handler
		await new Promise((r) => setTimeout(r, 5)); // let the closure run its guard
		expect(notices).toEqual([NOTICES.treeCancelled()]);
		expect(sends).toHaveLength(0);
		expect(st.getState()).toBe("idle");
	});

	it("consumerless (re-hydrated, nothing queued or parked): the handler emits and idles", async () => {
		const { pi, records, notices, emit } = makeFakePi();
		const st = createSwitchState();
		registerTreeHandler(pi, st);
		st.arm(payload); // re-hydrated after reload: dispatchQueued false, nothing parked
		await emit("session_tree", { type: "session_tree" });
		expect(records).toHaveLength(1);
		expect(notices).toEqual([NOTICES.treeCancelled()]);
		expect(st.getState()).toBe("idle");
	});

	it("a parked /fresh counts as a consumer: no handler-side emit", async () => {
		const { pi, notices, emit } = makeFakePi();
		const st = createSwitchState();
		registerTreeHandler(pi, st);
		st.arm(payload);
		st.toInFlight();
		st.setParkedFresh(true);
		await emit("session_tree", { type: "session_tree" });
		expect(notices).toHaveLength(0); // the parked /fresh will emit at its guard
		expect(st.getCancelled()).toBe(true);
	});

	it("the in-flight refresh does not clear the cancelled flag", async () => {
		const { pi, emit } = makeFakePi();
		const st = createSwitchState();
		registerTreeHandler(pi, st);
		st.arm(payload);
		st.toInFlight();
		st.setParkedFresh(true);
		await emit("session_tree", { type: "session_tree" });
		st.refreshInFlight({ ...payload, pointerTextStatic: "S2" });
		expect(st.getCancelled()).toBe(true);
		expect(st.getPayload()?.pointerTextStatic).toBe("S2");
	});

	it("the last-step guard aborts a cancelled switch with exactly one notice", async () => {
		const { pi, notices, emit } = makeFakePi();
		const st = createSwitchState();
		registerTreeHandler(pi, st);
		st.arm(payload);
		st.toInFlight();
		st.setParkedFresh(true); // a /fresh is parked in its drain
		await emit("session_tree", { type: "session_tree" });
		const proceed = lastStepGuard(st, (m) => notices.push(m));
		expect(proceed).toBe(false);
		expect(notices).toEqual([NOTICES.treeCancelled()]);
		expect(st.getState()).toBe("idle");
	});

	it("the last-step guard passes a clean switch and a dead runtime aborts silently", () => {
		const st = createSwitchState();
		st.arm(payload);
		st.toInFlight();
		const notices: string[] = [];
		expect(lastStepGuard(st, (m) => notices.push(m))).toBe(true);
		expect(notices).toHaveLength(0);
		st.markInactive();
		expect(lastStepGuard(st, (m) => notices.push(m))).toBe(false); // not dispatched path
		expect(st.getState()).toBe("idle");
	});
});
