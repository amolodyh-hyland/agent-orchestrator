import { describe, expect, it } from "vitest";
import { EMPTY_AWARENESS_STATE, type AwarenessRun, type AwarenessState } from "../../shared/multica-awareness";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import type { WorkspaceSession } from "../types/workspace";
import { buildStripCards, buildWhoView, isAwarenessActive, isAwarenessStale, isLiveSession, pickRun } from "./multica-who";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const SK = "cloud";

const run = (overrides: Partial<AwarenessRun> = {}): AwarenessRun & { serverKey: string } => ({
	serverKey: SK,
	id: "t1",
	workspaceId: "w1",
	issueId: "i1",
	agentId: "a1",
	status: "running",
	failureReason: null,
	retryPending: false,
	outcomeUnknown: false,
	startedAt: "2026-10-10T11:58:00Z",
	endedAt: null,
	isLeaderTask: false,
	autopilotRunId: null,
	parentTaskId: null,
	runtimeId: null,
	...overrides,
});

function state(overrides: Partial<AwarenessState> = {}): AwarenessState {
	return {
		...EMPTY_AWARENESS_STATE,
		masterEnabled: true,
		servers: [
			{
				serverKey: SK,
				label: "Multica Cloud",
				mode: "cloud",
				customUrl: "",
				apiUrl: "",
				enabled: true,
				credentialSource: "pasted",
				consentGranted: false,
				hasPastedToken: true,
				status: "live",
				meId: "me",
				workspaces: [{ workspaceId: "w1", slug: "acme", name: "Acme", watch: true, state: "live", attempt: 0, partial: false, transport: "socket" }],
			},
		],
		issues: [
			{ serverKey: SK, id: "i1", workspaceId: "w1", identifier: "MUL-1", title: "Agent issue", status: "todo", statusCategory: "todo", assigneeType: "agent", assigneeId: "a1", parentIssueId: null, projectId: null, revision: 1, updatedAt: "2026-10-10T11:00:00Z" },
			{ serverKey: SK, id: "i2", workspaceId: "w1", identifier: "MUL-2", title: "Mine", status: "todo", statusCategory: "todo", assigneeType: "member", assigneeId: "me", parentIssueId: null, projectId: null, revision: 1, updatedAt: "2026-10-10T11:30:00Z" },
			{ serverKey: SK, id: "i3", workspaceId: "w1", identifier: "MUL-3", title: "Closed", status: "done", statusCategory: "done", assigneeType: null, assigneeId: null, parentIssueId: null, projectId: null, revision: 1, updatedAt: "2026-10-09T11:30:00Z" },
		],
		runs: [run()],
		agents: [{ serverKey: SK, id: "a1", workspaceId: "w1", name: "Builder", runtimeId: null }],
		...overrides,
	};
}

const session = (id: string, overrides: Partial<WorkspaceSession> = {}): WorkspaceSession => ({ id, workspaceId: "p1", title: `Session ${id}`, status: "working", ...overrides }) as WorkspaceSession;
const link = (sessionId: string, identifier: string): MulticaIssueLink => ({ sessionId, projectId: "p1", workspaceSlug: "acme", issueIdentifier: identifier, createdAt: "2026-10-10T10:00:00Z", serverKey: SK });

describe("isAwarenessActive", () => {
	it("is false until a master switch, a server and a workspace are all on", () => {
		expect(isAwarenessActive(EMPTY_AWARENESS_STATE)).toBe(false);
		expect(isAwarenessActive(state())).toBe(true);
		expect(isAwarenessActive(state({ masterEnabled: false }))).toBe(false);
		expect(isAwarenessActive(state({ killSwitch: true }))).toBe(false);
		const s = state();
		s.servers[0].enabled = false;
		expect(isAwarenessActive(s)).toBe(false);
		const t = state();
		t.servers[0].workspaces[0].watch = false;
		expect(isAwarenessActive(t)).toBe(false);
	});
});

describe("buildWhoView", () => {
	it("lists agent-run, mine and skips closed issues without work", () => {
		const { rows } = buildWhoView({ state: state(), links: [], sessions: [], nowMs: NOW });
		expect(rows.map((row) => [row.identifier, row.derivation.display])).toEqual([
			["MUL-1", "multica-agent"],
			["MUL-2", "human"],
		]);
		expect(rows[0].agentNames).toEqual(["Builder"]);
		expect(rows[0].run?.view.state).toBe("running");
	});

	it("shows an issue once as contested when a live linked AO session meets a Multica run, first in the list", () => {
		const { rows } = buildWhoView({ state: state(), links: [link("s1", "MUL-1")], sessions: [session("s1")], nowMs: NOW });
		expect(rows[0]).toMatchObject({ identifier: "MUL-1", flags: ["contested"], sessions: [{ id: "s1", projectId: "p1" }] });
		expect(rows[0].derivation.display).toBe("contested");
		expect(rows.filter((row) => row.identifier === "MUL-1")).toHaveLength(1);
	});

	it("ignores terminated sessions when judging the executor", () => {
		const { rows } = buildWhoView({ state: state(), links: [link("s1", "MUL-1")], sessions: [session("s1", { isTerminated: true })], nowMs: NOW });
		expect(rows[0].derivation.contested).toBe(false);
	});

	it("shows a live linked session on an unassigned issue as ao", () => {
		const s = state();
		s.issues.push({ serverKey: SK, id: "i4", workspaceId: "w1", identifier: "MUL-4", title: "Free", status: "todo", statusCategory: "todo", assigneeType: null, assigneeId: null, parentIssueId: null, projectId: null, revision: 1, updatedAt: "2026-10-10T11:50:00Z" });
		const { rows } = buildWhoView({ state: s, links: [link("s9", "MUL-4")], sessions: [session("s9")], nowMs: NOW });
		expect(rows.find((row) => row.identifier === "MUL-4")?.derivation.display).toBe("ao");
	});

	it("flags assigned-not-running after five minutes", () => {
		const s = state({ runs: [] });
		const { rows } = buildWhoView({ state: s, links: [], sessions: [], nowMs: NOW });
		expect(rows.find((row) => row.identifier === "MUL-1")?.flags).toEqual(["assigned_not_running"]);
	});

	it("adds an orphaned row for a live session whose issue was deleted", () => {
		const s = state({ deleted: [{ serverKey: SK, workspaceId: "w1", identifier: "MUL-9" }] });
		const { rows } = buildWhoView({ state: s, links: [link("s7", "MUL-9")], sessions: [session("s7")], nowMs: NOW });
		expect(rows.find((row) => row.identifier === "MUL-9")).toMatchObject({ flags: ["orphaned"], derivation: { detail: "orphaned" } });
	});

	it("lists live worker sessions with no Multica link", () => {
		const { unlinkedSessions } = buildWhoView({
			state: state(),
			links: [link("s1", "MUL-1")],
			sessions: [session("s1"), session("s2"), session("s3", { isTerminated: true }), session("proj-orchestrator", { kind: "orchestrator" })],
			nowMs: NOW,
		});
		expect(unlinkedSessions.map((entry) => entry.id)).toEqual(["s2"]);
	});

	it("keeps servers apart", () => {
		const s = state();
		s.servers.push({ ...s.servers[0], serverKey: "other", label: "Other" });
		s.issues.push({ ...s.issues[0], serverKey: "other", id: "i1" });
		const { rows } = buildWhoView({ state: s, links: [link("s1", "MUL-1")], sessions: [session("s1")], nowMs: NOW });
		expect(rows.filter((row) => row.identifier === "MUL-1").map((row) => [row.serverKey, row.derivation.contested])).toEqual([
			[SK, true],
			["other", false],
		]);
	});

	it("sorts live-session helper", () => {
		expect(isLiveSession({ status: "working" })).toBe(true);
		expect(isLiveSession({ status: "terminated" })).toBe(false);
		expect(isLiveSession({ status: "working", isTerminated: true })).toBe(false);
	});
});

describe("buildStripCards", () => {
	it("makes one card per issue from its most urgent run, failed runs first", () => {
		const s = state({
			runs: [
				run({ id: "t1", status: "running" }),
				run({ id: "t2", status: "failed", endedAt: "2026-10-10T11:59:00Z", failureReason: "agent_error" }),
				run({ id: "t3", issueId: "i2", status: "queued", startedAt: null }),
				run({ id: "t4", issueId: "i3", status: "completed", endedAt: "2026-10-08T00:00:00Z" }),
			],
		});
		const cards = buildStripCards({ state: s, links: [], sessions: [], nowMs: NOW });
		expect(cards.map((card) => [card.identifier, card.view.state, card.view.lane])).toEqual([
			["MUL-1", "failed", "attention"],
			["MUL-2", "queued", "queued"],
		]);
		expect(cards[0].agentName).toBe("Builder");
	});

	it("marks a card contested and links the session when a live AO session shares the issue", () => {
		const cards = buildStripCards({ state: state(), links: [link("s1", "MUL-1")], sessions: [session("s1")], nowMs: NOW });
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ contested: true, sessions: [{ id: "s1" }] });
	});

	it("flags leader and autopilot runs", () => {
		const cards = buildStripCards({ state: state({ runs: [run({ isLeaderTask: true, autopilotRunId: "ap" })] }), links: [], sessions: [], nowMs: NOW });
		expect(cards[0]).toMatchObject({ isLeader: true, isAutopilot: true });
	});

	it("has no cards when there are no runs", () => {
		expect(buildStripCards({ state: state({ runs: [] }), links: [], sessions: [], nowMs: NOW })).toEqual([]);
	});

	it("picks the attention run over a running one", () => {
		const picked = pickRun([run({ id: "a" }), run({ id: "b", status: "failed", endedAt: "2026-10-10T11:59:00Z" })], NOW);
		expect(picked?.run.id).toBe("b");
	});
});

describe("isAwarenessStale", () => {
	it("is false for a live server with live workspaces and for servers that are off", () => {
		expect(isAwarenessStale(state())).toBe(false);
		const off = state();
		off.servers[0].enabled = false;
		off.servers[0].status = "off";
		expect(isAwarenessStale(off)).toBe(false);
	});

	it("is true for a server that is not live or a watched workspace that is not fully read", () => {
		for (const status of ["connecting", "degraded", "unreachable", "signed_out", "paused", "no_credential"] as const) {
			const s = state();
			s.servers[0].status = status;
			expect(isAwarenessStale(s), status).toBe(true);
		}
		for (const workspaceState of ["connecting", "authenticating", "backoff"] as const) {
			const s = state();
			s.servers[0].workspaces[0].state = workspaceState;
			expect(isAwarenessStale(s), workspaceState).toBe(true);
		}
		const idle = state();
		idle.servers[0].workspaces[0].watch = false;
		idle.servers[0].workspaces[0].state = "idle";
		expect(isAwarenessStale(idle)).toBe(false);
	});
});
