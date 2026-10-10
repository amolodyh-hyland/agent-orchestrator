import { describe, expect, it } from "vitest";
import {
	MULTICA_RECENT_RUN_WINDOW_MS,
	MULTICA_RETRY_WINDOW_MS,
	MULTICA_TASK_STATUSES,
	isAwarenessCommand,
	isOpenMulticaIssueRequest,
	multicaIssueJoinKey,
	multicaRunCardView,
	type MulticaTaskStatus,
} from "./multica-awareness";

const now = Date.parse("2026-10-10T12:00:00Z");
const view = (status: MulticaTaskStatus, extra: { retryPending?: boolean; endedAt?: string | null } = {}) =>
	multicaRunCardView({ status, retryPending: extra.retryPending ?? false, endedAt: extra.endedAt ?? null }, now);

describe("multicaRunCardView", () => {
	it("maps every task status to the card state, lane and tone of the design table", () => {
		expect(view("queued")).toEqual({ state: "queued", lane: "queued", tone: "pending" });
		expect(view("deferred")).toEqual({ state: "queued", lane: "queued", tone: "pending" });
		expect(view("dispatched")).toEqual({ state: "starting", lane: "running", tone: "working" });
		expect(view("running")).toEqual({ state: "running", lane: "running", tone: "working" });
		expect(view("waiting_local_directory")).toEqual({ state: "waiting_folder", lane: "running", tone: "pending" });
		expect(view("completed")).toEqual({ state: "finished", lane: "recent", tone: "done" });
		expect(view("failed")).toEqual({ state: "failed", lane: "attention", tone: "attention" });
		expect(view("failed", { retryPending: true })).toEqual({ state: "retrying", lane: "running", tone: "pending" });
		expect(view("cancelled")).toEqual({ state: "cancelled", lane: "recent", tone: "done" });
	});

	it("covers every status", () => {
		for (const status of MULTICA_TASK_STATUSES) expect(view(status)).not.toBeUndefined();
	});

	it("drops finished, failed and cancelled runs after 24 hours but keeps in-flight ones", () => {
		const stale = new Date(now - MULTICA_RECENT_RUN_WINDOW_MS - 1000).toISOString();
		const recent = new Date(now - MULTICA_RECENT_RUN_WINDOW_MS + 60_000).toISOString();
		for (const status of ["completed", "failed", "cancelled"] as const) {
			expect(view(status, { endedAt: stale })).toBeNull();
			expect(view(status, { endedAt: recent })).not.toBeNull();
		}
		expect(view("running", { endedAt: stale })).not.toBeNull();
	});

	it("shows a retry-pending failure as retrying only for ten minutes, then as a failure", () => {
		const justNow = new Date(now - 60_000).toISOString();
		const longAgo = new Date(now - MULTICA_RETRY_WINDOW_MS - 1000).toISOString();
		expect(view("failed", { retryPending: true, endedAt: justNow })?.state).toBe("retrying");
		expect(view("failed", { retryPending: true, endedAt: longAgo })?.state).toBe("failed");
	});
});

describe("multicaIssueJoinKey", () => {
	it("normalises the slug and identifier", () => {
		expect(multicaIssueJoinKey("cloud", "Acme", "mul-12")).toBe("cloud|acme|MUL-12");
	});
});

describe("isAwarenessCommand", () => {
	it("accepts every command with exactly its fields", () => {
		const accepted = [
			{ type: "setMaster", enabled: true },
			{ type: "addServer", mode: "local", customUrl: "http://localhost:3000", apiUrl: "" },
			{ type: "removeServer", serverKey: "cloud" },
			{ type: "setServerEnabled", serverKey: "cloud", enabled: false },
			{ type: "setCredentialSource", serverKey: "cloud", source: "pasted" },
			{ type: "grantConsent", serverKey: "cloud" },
			{ type: "revokeConsent", serverKey: "cloud" },
			{ type: "setToken", serverKey: "cloud", token: "mul_x" },
			{ type: "clearToken", serverKey: "cloud" },
			{ type: "setWorkspaceWatch", serverKey: "cloud", workspaceId: "w", watch: true },
			{ type: "refreshWorkspaces", serverKey: "cloud" },
			{ type: "setMaxSockets", value: 4 },
		];
		for (const command of accepted) expect(isAwarenessCommand(command)).toBe(true);
	});

	it("refuses unknown types, extra fields, wrong types and out-of-range values", () => {
		const refused = [
			null,
			"setMaster",
			{ type: "request", path: "/api/issues" },
			{ type: "setMaster", enabled: "yes" },
			{ type: "setMaster", enabled: true, extra: 1 },
			{ type: "setServerEnabled", serverKey: "", enabled: true },
			{ type: "setCredentialSource", serverKey: "cloud", source: "env" },
			{ type: "setToken", serverKey: "cloud", token: "" },
			{ type: "setMaxSockets", value: 9 },
			{ type: "setMaxSockets", value: 0 },
			{ type: "setMaxSockets", value: 1.5 },
			{ type: "addServer", mode: "remote", customUrl: "", apiUrl: "" },
		];
		for (const command of refused) expect(isAwarenessCommand(command)).toBe(false);
	});

	it("checks open-issue requests", () => {
		expect(isOpenMulticaIssueRequest({ serverKey: "cloud", workspaceSlug: "acme", identifier: "MUL-1" })).toBe(true);
		expect(isOpenMulticaIssueRequest({ serverKey: "cloud", workspaceSlug: "acme" })).toBe(false);
	});
});
