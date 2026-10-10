import { describe, expect, it } from "vitest";
import {
	buildOpenWithAoActionUrl,
	buildOpenWithAoPagePayload,
	buildOpenWithAoSyncView,
	deduceOpenWithAoProject,
	isOpenWithAoNonce,
	isOpenWithAoSnapshot,
	MAX_OPEN_WITH_AO_DETAIL,
	MAX_OPEN_WITH_AO_ID,
	MAX_OPEN_WITH_AO_NAME,
	MAX_OPEN_WITH_AO_PROJECTS,
	MAX_OPEN_WITH_AO_SESSIONS,
	MAX_OPEN_WITH_AO_STATE_LABEL,
	MENU_BORDER_COLOR_MIX_PERCENT,
	MENU_BORDER_WIDTH,
	MENU_BORDER_WIDTH_HIDPI,
	MENU_MAX_HEIGHT_PX,
	OPTION_FONT_SIZE,
	OPTION_FONT_WEIGHT,
	OPTION_LINE_HEIGHT,
	OPTION_PADDING_Y,
	OPEN_WITH_AO_ACTION_PREFIX,
	OPEN_WITH_AO_LABEL,
	OPEN_WITH_AO_STYLE,
	parseOpenWithAoActionUrl,
	sortOpenWithAoSessions,
	type OpenWithAoAction,
	type OpenWithAoProject,
	type OpenWithAoSession,
	type OpenWithAoSnapshot,
} from "./multica-open-with-ao";
import type { MulticaSyncLinkView } from "./multica-status-sync";

const NONCE = "nonce-1234567890";

const session = (overrides: Partial<OpenWithAoSession> = {}): OpenWithAoSession => ({
	id: "session-1",
	projectId: "project-1",
	label: "Worker",
	tone: "ready",
	stateLabel: "Ready",
	detail: "",
	stale: false,
	terminated: false,
	updatedAt: 1,
	...overrides,
});

const project = (overrides: Partial<OpenWithAoProject> = {}): OpenWithAoProject => ({
	id: "project-1",
	name: "Project One",
	orchestrator: null,
	sessions: [],
	moreCount: 0,
	...overrides,
});

const snapshot = (projects: OpenWithAoProject[] = [], overrides: Partial<OpenWithAoSnapshot> = {}): OpenWithAoSnapshot => ({
	daemon: "ready",
	stale: false,
	projects,
	...overrides,
});

describe("isOpenWithAoSnapshot", () => {
	it("accepts empty, single-project, and multi-project snapshots", () => {
		expect(isOpenWithAoSnapshot(snapshot())).toBe(true);
		expect(isOpenWithAoSnapshot(snapshot([project({ sessions: [session()] })]))).toBe(true);
		expect(
			isOpenWithAoSnapshot(
				snapshot([
					project({ sessions: [session()] }),
					project({ id: "project-2", name: "Project Two", sessions: [session({ id: "session-2", projectId: "project-2" })] }),
				]),
			),
		).toBe(true);
	});

	it.each([
		["extra snapshot key", { daemon: "ready", stale: false, projects: [], extra: true }],
		["missing snapshot key", { daemon: "ready", stale: false }],
		["bad tone", snapshot([project({ sessions: [session({ tone: "bad" as OpenWithAoSession["tone"] })] })])],
		["bad daemon", { daemon: "unknown", stale: false, projects: [] }],
		[
			"over-cap projects",
			snapshot(Array.from({ length: MAX_OPEN_WITH_AO_PROJECTS + 1 }, (_, index) => project({ id: `project-${index}`, name: `Project ${index}` }))),
		],
		[
			"over-cap sessions",
			snapshot([project({ sessions: Array.from({ length: MAX_OPEN_WITH_AO_SESSIONS + 1 }, (_, index) => session({ id: `session-${index}` })) })]),
		],
		["duplicate project id", snapshot([project(), project({ name: "Other name" })])],
		[
			"duplicate session id across orchestrator and worker",
			snapshot([project({ orchestrator: session({ label: "Orchestrator" }), sessions: [session()] })]),
		],
		["session projectId mismatch", snapshot([project({ sessions: [session({ projectId: "another-project" })] })])],
		["over-long project id", snapshot([project({ id: "p".repeat(MAX_OPEN_WITH_AO_ID + 1) })])],
		["over-long session id", snapshot([project({ sessions: [session({ id: "s".repeat(MAX_OPEN_WITH_AO_ID + 1) })] })])],
		["over-long project name", snapshot([project({ name: "n".repeat(MAX_OPEN_WITH_AO_NAME + 1) })])],
		["over-long label", snapshot([project({ sessions: [session({ label: "l".repeat(MAX_OPEN_WITH_AO_NAME + 1) })] })])],
		["over-long state label", snapshot([project({ sessions: [session({ stateLabel: "s".repeat(MAX_OPEN_WITH_AO_STATE_LABEL + 1) })] })])],
		["over-long detail", snapshot([project({ sessions: [session({ detail: "d".repeat(MAX_OPEN_WITH_AO_DETAIL + 1) })] })])],
		["empty label", snapshot([project({ sessions: [session({ label: "" })] })])],
		["negative updatedAt", snapshot([project({ sessions: [session({ updatedAt: -1 })] })])],
		["float updatedAt", snapshot([project({ sessions: [session({ updatedAt: 1.5 })] })])],
		["negative moreCount", snapshot([project({ moreCount: -1 })])],
		["float moreCount", snapshot([project({ moreCount: 1.5 })])],
		["non-object input", "snapshot"],
		["array input", []],
	])("rejects %s", (_name, value) => {
		expect(isOpenWithAoSnapshot(value)).toBe(false);
	});

	it("requires exact plain-object keys and counts text limits in code points", () => {
		const symbolExtra = Object.assign(project(), { [Symbol("extra")]: true });
		const inherited = Object.assign(Object.create({ inherited: true }), project());
		expect(isOpenWithAoSnapshot(snapshot([symbolExtra]))).toBe(false);
		expect(isOpenWithAoSnapshot(snapshot([inherited]))).toBe(false);
		expect(isOpenWithAoSnapshot(snapshot([project({ id: "😀".repeat(MAX_OPEN_WITH_AO_ID) })]))).toBe(true);
		expect(isOpenWithAoSnapshot(snapshot([project({ id: "😀".repeat(MAX_OPEN_WITH_AO_ID + 1) })]))).toBe(false);
		expect(isOpenWithAoSnapshot(snapshot([project({ sessions: [session({ label: "😀".repeat(MAX_OPEN_WITH_AO_NAME) })] })]))).toBe(true);
	});

	it("rejects arrays with extra keys, symbols, or holes", () => {
		const projectsWithExtraKey = Object.assign([project()], { extra: true });
		const sessionsWithExtraKey = Object.assign([session()], { extra: true });
		const projectsWithSymbolKey = Object.assign([project()], { [Symbol("extra")]: true });
		const sparseProjects = new Array<OpenWithAoProject>(1);
		const projectsWithLargeExtraKey = Object.assign([], { extra: "x".repeat(1000) });

		expect(isOpenWithAoSnapshot({ ...snapshot(), projects: projectsWithExtraKey })).toBe(false);
		expect(isOpenWithAoSnapshot(snapshot([project({ sessions: sessionsWithExtraKey })]))).toBe(false);
		expect(isOpenWithAoSnapshot({ ...snapshot(), projects: projectsWithSymbolKey })).toBe(false);
		expect(isOpenWithAoSnapshot({ ...snapshot(), projects: sparseProjects })).toBe(false);
		expect(isOpenWithAoSnapshot({ ...snapshot(), projects: projectsWithLargeExtraKey })).toBe(false);
	});
});

describe("Open in AO action URLs", () => {
	it("round trips open actions with and without a workspace slug and new-task actions", () => {
		const open: OpenWithAoAction = { kind: "open", projectId: "a project%雪", sessionId: "session %😀", nonce: NONCE };
		const openWithWorkspace: OpenWithAoAction = { ...open, workspaceSlug: "acme_workspace-2" };
		const newTask: OpenWithAoAction = { kind: "new-task", projectId: "project %雪", nonce: NONCE };
		expect(parseOpenWithAoActionUrl(buildOpenWithAoActionUrl(open))).toEqual(open);
		expect(parseOpenWithAoActionUrl(buildOpenWithAoActionUrl(openWithWorkspace))).toEqual(openWithWorkspace);
		expect(parseOpenWithAoActionUrl(buildOpenWithAoActionUrl(newTask))).toEqual(newTask);
	});

	it.each([
		["wrong prefix", "https://example.test/open-with-ao/open/project/session?n=" + NONCE],
		["missing n", `${OPEN_WITH_AO_ACTION_PREFIX}open/project/session`],
		["extra query", `${OPEN_WITH_AO_ACTION_PREFIX}open/project/session?n=${NONCE}&x=1`],
		["workspace slug first", `${OPEN_WITH_AO_ACTION_PREFIX}open/project/session?w=acme&n=${NONCE}`],
		["duplicate workspace slug", `${OPEN_WITH_AO_ACTION_PREFIX}open/project/session?n=${NONCE}&w=acme&w=other`],
		["upper-case workspace slug", `${OPEN_WITH_AO_ACTION_PREFIX}open/project/session?n=${NONCE}&w=Acme`],
		["bad workspace slug characters", `${OPEN_WITH_AO_ACTION_PREFIX}open/project/session?n=${NONCE}&w=bad%20slug`],
		["workspace slug on new-task", `${OPEN_WITH_AO_ACTION_PREFIX}new-task/project?n=${NONCE}&w=acme`],
		["extra pair after workspace slug", `${OPEN_WITH_AO_ACTION_PREFIX}open/project/session?n=${NONCE}&w=acme&x=1`],
		["short nonce", `${OPEN_WITH_AO_ACTION_PREFIX}new-task/project?n=short`],
		["bad nonce characters", `${OPEN_WITH_AO_ACTION_PREFIX}new-task/project?n=${"a".repeat(15)}!`],
		["hash", `${OPEN_WITH_AO_ACTION_PREFIX}new-task/project?n=${NONCE}#fragment`],
		["open missing session", `${OPEN_WITH_AO_ACTION_PREFIX}open/project?n=${NONCE}`],
		["open extra segment", `${OPEN_WITH_AO_ACTION_PREFIX}open/project/session/extra?n=${NONCE}`],
		["new-task extra segment", `${OPEN_WITH_AO_ACTION_PREFIX}new-task/project/extra?n=${NONCE}`],
		["upper-case kind", `${OPEN_WITH_AO_ACTION_PREFIX}OPEN/project/session?n=${NONCE}`],
		["decoded slash", `${OPEN_WITH_AO_ACTION_PREFIX}open/project%2Fsub/session?n=${NONCE}`],
		["blank id", `${OPEN_WITH_AO_ACTION_PREFIX}new-task/%20%20?n=${NONCE}`],
		["control character", `${OPEN_WITH_AO_ACTION_PREFIX}open/project%00/session?n=${NONCE}`],
		["malformed escape", `${OPEN_WITH_AO_ACTION_PREFIX}new-task/%E0%A4%A?n=${NONCE}`],
		["non-string input", 42],
	])("rejects %s", (_name, url) => {
		expect(parseOpenWithAoActionUrl(url)).toBeNull();
	});

	it("builds only actions that parse successfully", () => {
		expect(() => buildOpenWithAoActionUrl({ kind: "new-task", projectId: "project", nonce: "short" })).toThrow(
			"invalid open-with-ao action",
		);
		expect(() => buildOpenWithAoActionUrl({ kind: "new-task", projectId: "  ", nonce: NONCE })).toThrow("invalid open-with-ao action");
		expect(() => buildOpenWithAoActionUrl({ kind: "open", projectId: "project", sessionId: "", nonce: NONCE })).toThrow(
			"invalid open-with-ao action",
		);
		expect(() => buildOpenWithAoActionUrl({ kind: "open", projectId: "project", sessionId: "session", nonce: NONCE, workspaceSlug: "Acme" })).toThrow(
			"invalid open-with-ao action",
		);
		expect(() => buildOpenWithAoActionUrl({ kind: "open", projectId: "project", sessionId: "session", nonce: NONCE, workspaceSlug: "a".repeat(64) })).toThrow(
			"invalid open-with-ao action",
		);
		expect(isOpenWithAoNonce(NONCE)).toBe(true);
		expect(isOpenWithAoNonce("short")).toBe(false);
	});
});

describe("deduceOpenWithAoProject", () => {
	it.each([
		["one linked project", ["p1"], ["p1", "p2"], { projectId: "p1", reason: "linked" }],
		["ambiguous links", ["p1", "p2"], ["p1", "p2"], { projectId: null, reason: null }],
		["duplicate links", ["p1", "p1"], ["p1", "p2"], { projectId: "p1", reason: "linked" }],
		["one ineligible link falls through to only-project", ["outside"], ["p1"], { projectId: "p1", reason: "only-project" }],
		["two ineligible linked projects remain ambiguous", ["missing-a", "missing-b"], ["p"], { projectId: null, reason: null }],
		["eligible and ineligible linked projects remain ambiguous", ["p", "missing"], ["p", "other"], { projectId: null, reason: null }],
		["one missing link falls through to only-project", ["missing"], ["p"], { projectId: "p", reason: "only-project" }],
		["one eligible project", [], ["p1"], { projectId: "p1", reason: "only-project" }],
		["several eligible projects", [], ["p1", "p2"], { projectId: null, reason: null }],
		["no eligible projects", [], [], { projectId: null, reason: null }],
	])("deduces %s", (_name, linkedProjectIds, eligibleProjectIds, expected) => {
		expect(deduceOpenWithAoProject({ linkedProjectIds, eligibleProjectIds })).toEqual(expected);
	});
});

describe("sortOpenWithAoSessions", () => {
	it("applies linked, termination, tone, updated time, and id ordering without mutation", () => {
		const sessions = [
			session({ id: "z", tone: "ready", updatedAt: 9 }),
			session({ id: "linked-working", tone: "working", updatedAt: 1 }),
			session({ id: "linked-terminated", tone: "ready", terminated: true }),
			session({ id: "beta", tone: "ready", updatedAt: 9 }),
			session({ id: "alpha", tone: "ready", updatedAt: 9 }),
			session({ id: "attention", tone: "attention", updatedAt: 100 }),
			session({ id: "terminated", tone: "ready", terminated: true }),
		];
		const before = [...sessions];
		const sorted = sortOpenWithAoSessions(sessions, new Set(["linked-working", "linked-terminated"]));
		expect(sorted.map(({ id }) => id)).toEqual([
			"linked-working",
			"linked-terminated",
			"alpha",
			"beta",
			"z",
			"attention",
			"terminated",
		]);
		expect(sessions).toEqual(before);
		expect(sorted).not.toBe(sessions);
	});

	it("keeps exact ties stable", () => {
		const first = { ...session({ id: "same" }), marker: "first" };
		const second = { ...session({ id: "same" }), marker: "second" };
		expect(sortOpenWithAoSessions([first, second], new Set()).map(({ marker }) => marker)).toEqual(["first", "second"]);
	});
});

describe("buildOpenWithAoPagePayload", () => {
	it("returns an unknown empty payload when no snapshot has arrived", () => {
		expect(
			buildOpenWithAoPagePayload({ snapshot: null, links: [], issue: null, nonce: NONCE }),
		).toEqual({
			label: OPEN_WITH_AO_LABEL,
			style: OPEN_WITH_AO_STYLE,
			nonce: NONCE,
			issue: null,
			daemon: "unknown",
			stale: false,
			deducedProjectId: null,
			deduction: null,
			projects: [],
		});
		expect(OPEN_WITH_AO_LABEL).toBe("Open in AO");
		expect(MENU_MAX_HEIGHT_PX).toBe(283);
		expect(MENU_BORDER_WIDTH).toBe("1px");
		expect(MENU_BORDER_WIDTH_HIDPI).toBe("0.5px");
		expect(MENU_BORDER_COLOR_MIX_PERCENT).toBe(55);
		expect(OPTION_FONT_SIZE).toBe("12px");
		expect(OPTION_FONT_WEIGHT).toBe("400");
		expect(OPTION_LINE_HEIGHT).toBe("16px");
		expect(OPTION_PADDING_Y).toBe("6px");
		expect(OPEN_WITH_AO_STYLE).toEqual({
			borderWidth: MENU_BORDER_WIDTH,
			borderWidthHiDpi: MENU_BORDER_WIDTH_HIDPI,
			borderColorMixPercent: MENU_BORDER_COLOR_MIX_PERCENT,
			menuFontSize: OPTION_FONT_SIZE,
			menuStateFontSize: "11px",
			menuLabelFontSize: "11px",
			menuFontWeight: OPTION_FONT_WEIGHT,
			menuLineHeight: OPTION_LINE_HEIGHT,
			menuRowPaddingY: OPTION_PADDING_Y,
			menuMaxHeightPx: MENU_MAX_HEIGHT_PX,
		});
	});

	it("does not mark sessions linked when there is no issue", () => {
		const result = buildOpenWithAoPagePayload({
			snapshot: snapshot([project({ sessions: [session()] })]),
			links: [{ sessionId: "session-1", issueIdentifier: "ABC-1", projectId: "project-1" }],
			issue: null,
			nonce: NONCE,
		});
		expect(result.style).toBe(OPEN_WITH_AO_STYLE);
		expect(result.projects[0].linked).toBe(false);
		expect(result.projects[0].sessions[0].linked).toBe(false);
	});

	it("marks linked workers and deduces their project", () => {
		const result = buildOpenWithAoPagePayload({
			snapshot: snapshot([
				project({ sessions: [session()] }),
				project({ id: "project-2", name: "Second", sessions: [session({ id: "session-2", projectId: "project-2" })] }),
			]),
			links: [{ sessionId: "session-1", issueIdentifier: "ABC-1", projectId: "project-1" }],
			issue: { identifier: "ABC-1", title: "A task" },
			nonce: NONCE,
		});
		expect(result.label).toBe(OPEN_WITH_AO_LABEL);
		expect(result.projects.find(({ id }) => id === "project-1")).toMatchObject({ linked: true, sessions: [{ linked: true }] });
		expect(result.deducedProjectId).toBe("project-1");
		expect(result.deduction).toBe("linked");
	});

	it("never marks an orchestrator linked or uses its link to mark the project", () => {
		const result = buildOpenWithAoPagePayload({
			snapshot: snapshot([project({ orchestrator: session({ id: "orchestrator" }), sessions: [] })]),
			links: [{ sessionId: "orchestrator", issueIdentifier: "ABC-1", projectId: "project-1" }],
			issue: { identifier: "ABC-1", title: "A task" },
			nonce: NONCE,
		});
		expect(result.projects[0].orchestrator?.linked).toBe(false);
		expect(result.projects[0].linked).toBe(false);
		expect(result.deducedProjectId).toBe("project-1");
		expect(result.deduction).toBe("only-project");
	});

	it("leaves ambiguous linked projects without a deduction", () => {
		const result = buildOpenWithAoPagePayload({
			snapshot: snapshot([
				project({ sessions: [session()] }),
				project({ id: "project-2", name: "Second", sessions: [session({ id: "session-2", projectId: "project-2" })] }),
			]),
			links: [
				{ sessionId: "session-1", issueIdentifier: "ABC-1", projectId: "project-1" },
				{ sessionId: "session-2", issueIdentifier: "ABC-1", projectId: "project-2" },
			],
			issue: { identifier: "ABC-1", title: "A task" },
			nonce: NONCE,
		});
		expect(result.deducedProjectId).toBeNull();
		expect(result.deduction).toBeNull();
	});

	it("keeps omitted linked projects in ambiguity checks", () => {
		const result = buildOpenWithAoPagePayload({
			snapshot: snapshot([project({ sessions: [session()] })]),
			links: [
				{ sessionId: "session-1", issueIdentifier: "ABC-1", projectId: "project-1" },
				{ sessionId: "omitted-session", issueIdentifier: "ABC-1", projectId: "omitted-project" },
			],
			issue: { identifier: "ABC-1", title: "A task" },
			nonce: NONCE,
		});
		expect(result.projects[0].linked).toBe(true);
		expect(result.deducedProjectId).toBeNull();
		expect(result.deduction).toBeNull();
	});

	it("marks and deduces a linked project when its linked worker was cut by the cap", () => {
		const sessions = Array.from({ length: MAX_OPEN_WITH_AO_SESSIONS }, (_, index) =>
			session({ id: `session-${index}` }),
		);
		const result = buildOpenWithAoPagePayload({
			snapshot: snapshot([project({ sessions, moreCount: 1 })]),
			links: [{ sessionId: "cut-worker", issueIdentifier: "ABC-1", projectId: "project-1" }],
			issue: { identifier: "ABC-1", title: "A task" },
			nonce: NONCE,
		});
		expect(result.projects[0].linked).toBe(true);
		expect(result.projects[0].sessions.every(({ linked }) => !linked)).toBe(true);
		expect(result.deducedProjectId).toBe("project-1");
		expect(result.deduction).toBe("linked");
	});

	it("sorts projects by linked status, case-insensitive name, and id", () => {
		const result = buildOpenWithAoPagePayload({
			snapshot: snapshot([
				project({ id: "z", name: "alpha" }),
				project({ id: "b", name: "Beta" }),
				project({ id: "a", name: "ALPHA" }),
				project({ id: "linked", name: "Zulu", sessions: [session({ id: "linked-session" })] }),
			]),
			links: [{ sessionId: "linked-session", issueIdentifier: "ABC-1", projectId: "linked" }],
			issue: { identifier: "ABC-1", title: "A task" },
			nonce: NONCE,
		});
		expect(result.projects.map(({ id }) => id)).toEqual(["linked", "a", "z", "b"]);
	});

	it("sorts worker sessions and preserves the input snapshot", () => {
		const original = snapshot([
			project({
				name: "Workers",
				sessions: [
					session({ id: "later", updatedAt: 1 }),
					session({ id: "linked", tone: "working", updatedAt: 0 }),
					session({ id: "ready", updatedAt: 4 }),
				],
			}),
		]);
		const before = structuredClone(original);
		const result = buildOpenWithAoPagePayload({
			snapshot: original,
			links: [{ sessionId: "linked", issueIdentifier: "ABC-1", projectId: "project-1" }],
			issue: { identifier: "ABC-1", title: "A task" },
			nonce: NONCE,
		});
		expect(result.projects[0].sessions.map(({ id }) => id)).toEqual(["linked", "ready", "later"]);
		expect(original).toEqual(before);
	});
});

const syncView = (overrides: Partial<MulticaSyncLinkView> = {}): MulticaSyncLinkView => ({
	sessionId: "session-1",
	workspaceSlug: "acme",
	issueIdentifier: "ABC-1",
	enabled: true,
	state: "synced",
	reason: null,
	multicaStatus: "in_progress",
	aoStatus: "in_progress",
	lastSyncAt: null,
	canResume: false,
	canReopen: false,
	...overrides,
});

describe("buildOpenWithAoSyncView", () => {
	const on = { enabled: true, killSwitch: false };

	it("offers to turn the sync on for a link that is off, only when the master switch is on", () => {
		expect(buildOpenWithAoSyncView(syncView({ enabled: false, state: "off" }), on)).toEqual({
			tone: "unknown",
			label: "Keep this ticket updated",
			stateLabel: "Off",
			action: "enable",
		});
		expect(buildOpenWithAoSyncView(undefined, on).action).toBe("enable");
		expect(buildOpenWithAoSyncView(undefined, { enabled: false, killSwitch: false })).toEqual({
			tone: "unknown",
			label: "Ticket updates are off in Settings",
			stateLabel: "",
			action: null,
		});
	});

	it("shows an enabled link as stoppable with its state", () => {
		expect(buildOpenWithAoSyncView(syncView(), on)).toEqual({ tone: "ready", label: "Stop updating this ticket", stateLabel: "Synced", action: "disable" });
		expect(buildOpenWithAoSyncView(syncView({ state: "pending" }), on)).toMatchObject({ stateLabel: "Syncing…", action: "disable" });
	});

	it("shows a paused link as resumable when someone changed it in Multica, and as informational when it is closed", () => {
		expect(buildOpenWithAoSyncView(syncView({ state: "paused", reason: "changed_in_multica", canResume: true }), on)).toEqual({
			tone: "pending",
			label: "Resume updating this ticket",
			stateLabel: "Paused: changed in Multica",
			action: "resume",
		});
		expect(buildOpenWithAoSyncView(syncView({ state: "paused", reason: "closed_in_multica", canReopen: true }), on)).toEqual({
			tone: "pending",
			label: "Stop updating this ticket",
			stateLabel: "Paused: closed in Multica",
			action: "disable",
		});
	});

	it("names every refusal and every error in words", () => {
		const refusals = ["driven_by_multica", "triage", "identity_changed", "would_start_run", "secondary_link", "sub_issue_parent"] as const;
		for (const reason of refusals) {
			const row = buildOpenWithAoSyncView(syncView({ state: "refused", reason }), on);
			expect(row.tone).toBe("pending");
			expect(row.stateLabel.length).toBeGreaterThan(3);
		}
		expect(buildOpenWithAoSyncView(syncView({ state: "refused", reason: "driven_by_multica" }), on).stateLabel).toBe("Driven by Multica");
		const errors = ["signed_out", "unavailable", "unreachable", "no_access", "orphaned", "rate_limited", "ao_offline"] as const;
		for (const reason of errors) {
			const row = buildOpenWithAoSyncView(syncView({ state: "error", reason }), on);
			expect(row.stateLabel.length).toBeGreaterThan(3);
			expect(row.action).toBe("disable");
		}
		expect(buildOpenWithAoSyncView(syncView({ state: "error", reason: "signed_out" }), on).tone).toBe("attention");
	});

	it("says the sync is off while the master switch is off or the kill switch is set", () => {
		expect(buildOpenWithAoSyncView(syncView({ state: "off", reason: "master_off" }), { enabled: false, killSwitch: false })).toEqual({
			tone: "unknown",
			label: "Stop updating this ticket",
			stateLabel: "Off in Settings",
			action: "disable",
		});
		expect(buildOpenWithAoSyncView(syncView(), { enabled: true, killSwitch: true })).toMatchObject({ label: "Ticket updates are disabled", action: "disable" });
		expect(buildOpenWithAoSyncView(syncView({ enabled: false, state: "off" }), { enabled: true, killSwitch: true }).action).toBeNull();
	});
});

describe("sync actions in the page payload and in action URLs", () => {
	it("round-trips a sync action URL", () => {
		for (const syncAction of ["enable", "disable", "resume"] as const) {
			const url = buildOpenWithAoActionUrl({ kind: "sync", syncAction, projectId: "project 1", sessionId: "session/1".replace("/", "-"), nonce: NONCE });
			expect(url).toBe(`${OPEN_WITH_AO_ACTION_PREFIX}sync/${syncAction}/project%201/session-1?n=${NONCE}`);
			expect(parseOpenWithAoActionUrl(url)).toEqual({ kind: "sync", syncAction, projectId: "project 1", sessionId: "session-1", nonce: NONCE });
		}
	});

	it("refuses a malformed sync action URL", () => {
		const base = `${OPEN_WITH_AO_ACTION_PREFIX}sync`;
		for (const url of [
			`${base}/delete/p/s?n=${NONCE}`,
			`${base}/enable/p?n=${NONCE}`,
			`${base}/enable/p/s/extra?n=${NONCE}`,
			`${base}/enable//s?n=${NONCE}`,
			`${base}/enable/p/s?n=${NONCE}&w=acme`,
			`${base}/enable/p/s`,
			`${base}/enable/p/s?n=short`,
		]) {
			expect(parseOpenWithAoActionUrl(url)).toBeNull();
		}
		expect(() => buildOpenWithAoActionUrl({ kind: "sync", syncAction: "destroy" as never, projectId: "p", sessionId: "s", nonce: NONCE })).toThrow();
	});

	it("adds a sync row only to workers linked to the issue on screen", () => {
		const result = buildOpenWithAoPagePayload({
			snapshot: snapshot([project({ orchestrator: session({ id: "orchestrator" }), sessions: [session(), session({ id: "session-2" })] })]),
			links: [{ sessionId: "session-1", issueIdentifier: "ABC-1", projectId: "project-1" }],
			issue: { identifier: "ABC-1", title: "A task" },
			nonce: NONCE,
			sync: { enabled: true, killSwitch: false, views: [syncView(), syncView({ sessionId: "session-1", issueIdentifier: "ABC-2", state: "error", reason: "orphaned" })] },
		});

		const [linked, other] = result.projects[0].sessions;
		expect(linked.sync).toMatchObject({ label: "Stop updating this ticket", stateLabel: "Synced" });
		expect(other.sync).toBeNull();
		expect(result.projects[0].orchestrator?.sync).toBeNull();
	});

	it("adds no sync row when sync is not provided or no issue is on screen", () => {
		const base = { snapshot: snapshot([project({ sessions: [session()] })]), links: [{ sessionId: "session-1", issueIdentifier: "ABC-1", projectId: "project-1" }], nonce: NONCE };
		expect(buildOpenWithAoPagePayload({ ...base, issue: { identifier: "ABC-1", title: "A task" } }).projects[0].sessions[0].sync).toBeNull();
		expect(
			buildOpenWithAoPagePayload({ ...base, issue: null, sync: { enabled: true, killSwitch: false, views: [syncView()] } }).projects[0].sessions[0].sync,
		).toBeNull();
	});

	it("offers to turn the sync on for a linked worker that has no state yet", () => {
		const result = buildOpenWithAoPagePayload({
			snapshot: snapshot([project({ sessions: [session()] })]),
			links: [{ sessionId: "session-1", issueIdentifier: "ABC-1", projectId: "project-1" }],
			issue: { identifier: "ABC-1", title: "A task" },
			nonce: NONCE,
			sync: { enabled: true, killSwitch: false, views: [] },
		});
		expect(result.projects[0].sessions[0].sync).toMatchObject({ label: "Keep this ticket updated", action: "enable" });
	});
});
