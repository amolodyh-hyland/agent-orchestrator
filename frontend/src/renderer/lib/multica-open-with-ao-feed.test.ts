import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import {
	MAX_OPEN_WITH_AO_NAME,
	MAX_OPEN_WITH_AO_PROJECTS,
	MAX_OPEN_WITH_AO_SESSIONS,
	isOpenWithAoSnapshot,
} from "../../shared/multica-open-with-ao";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";
import { foundSessionEntry } from "./multica-link-status";
import { buildOpenWithAoSnapshot } from "./multica-open-with-ao-feed";

const t = ((key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key) as TFunction;

function session(id: string, overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
	return {
		id,
		workspaceId: "project-1",
		workspaceName: "Project One",
		title: id,
		provider: "claude-code",
		status: "working",
		updatedAt: "2026-01-01T00:00:00.000Z",
		prs: [],
		...overrides,
	};
}

function workspace(id: string, sessions: WorkspaceSession[] = [], overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
	return { id, name: id, path: "", sessions, ...overrides };
}

function link(sessionId: string, projectId = "some-other-project"): MulticaIssueLink {
	return {
		sessionId,
		projectId,
		workspaceSlug: "acme",
		issueIdentifier: "MUL-1",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

function build(workspaces: readonly WorkspaceSummary[], options: { links?: readonly MulticaIssueLink[]; daemon?: "ready" | "starting" | "stopped" | "error"; stale?: boolean } = {}) {
	return buildOpenWithAoSnapshot({
		workspaces,
		links: options.links ?? [],
		daemon: options.daemon ?? "ready",
		stale: options.stale ?? false,
		t,
	});
}

describe("buildOpenWithAoSnapshot", () => {
	it("splits the live orchestrator from workers and ignores terminated orchestrators", () => {
		const result = build([
			workspace("project-1", [
				session("worker-1"),
				session("orchestrator-old", { kind: "orchestrator", createdAt: "2026-01-01T00:00:00Z" }),
				session("orchestrator-new", { kind: "orchestrator", createdAt: "2026-02-01T00:00:00Z" }),
				session("orchestrator-dead", { kind: "orchestrator", status: "terminated", isTerminated: true, createdAt: "2026-03-01T00:00:00Z" }),
			]),
			workspace("project-2", [session("only-dead-orchestrator", { kind: "orchestrator", status: "terminated" })]),
		]);

		expect(result.projects[0].orchestrator?.id).toBe("orchestrator-new");
		expect(result.projects[0].sessions.map(({ id }) => id)).toEqual(["worker-1"]);
		expect(result.projects[1].orchestrator).toBeNull();
		expect(result.projects[1].sessions).toEqual([]);
		expect(isOpenWithAoSnapshot(result)).toBe(true);
	});

	it("excludes standalone and cloud projects", () => {
		const result = build([
			workspace("__standalone__", [session("standalone-worker")]),
			workspace("cloud-project", [session("cloud-worker")], { kind: "cloud" }),
			workspace("local-project", [session("local-worker")]),
		]);

		expect(result.projects.map(({ id }) => id)).toEqual(["local-project"]);
		expect(isOpenWithAoSnapshot(result)).toBe(true);
	});

	it("keeps the first 50 projects when no project has priority", () => {
		const workspaces = Array.from({ length: 60 }, (_, index) => workspace(`project-${index}`));
		const result = build(workspaces);

		expect(result.projects).toHaveLength(MAX_OPEN_WITH_AO_PROJECTS);
		expect(result.projects[0].id).toBe("project-0");
		expect(result.projects.at(-1)?.id).toBe("project-49");
		expect(isOpenWithAoSnapshot(result)).toBe(true);
	});

	it("keeps a linked worker project at index 59 ahead of the project cap", () => {
		const workspaces = Array.from({ length: 60 }, (_, index) => workspace(`project-${index}`));
		workspaces[59] = workspace("project-59", [session("linked-worker", { status: "terminated", isTerminated: true })]);
		const result = build(workspaces, { links: [link("linked-worker")] });

		expect(result.projects).toHaveLength(MAX_OPEN_WITH_AO_PROJECTS);
		expect(result.projects[0].id).toBe("project-59");
		expect(result.projects[0].sessions.map(({ id }) => id)).toEqual(["linked-worker"]);
		expect(isOpenWithAoSnapshot(result)).toBe(true);
	});

	it("keeps an active worker project at index 59 ahead of empty and terminated-only projects", () => {
		const workspaces = Array.from({ length: 60 }, (_, index) =>
			workspace(
				`project-${index}`,
				index % 2 === 0 ? [] : [session(`terminated-${index}`, { status: "terminated", isTerminated: true })],
			),
		);
		workspaces[59] = workspace("project-59", [session("active-worker-59")]);
		const result = build(workspaces);

		expect(result.projects).toHaveLength(MAX_OPEN_WITH_AO_PROJECTS);
		expect(result.projects[0].id).toBe("project-59");
		expect(result.projects.slice(1).map(({ id }) => id)).toEqual(
			Array.from({ length: MAX_OPEN_WITH_AO_PROJECTS - 1 }, (_, index) => `project-${index}`),
		);
		expect(isOpenWithAoSnapshot(result)).toBe(true);
	});

	it("caps workers and prioritizes links from any project before active and recent sessions", () => {
		const workers = Array.from({ length: 60 }, (_, index) => {
			const timestamp = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
			return session(`worker-${index}`, {
				createdAt: timestamp,
				lastUserMessageAt: timestamp,
				status: index === 58 ? "terminated" : "working",
				isTerminated: index === 58,
			});
		});
		const result = build([workspace("project-1", workers)], { links: [link("worker-0")] });
		const project = result.projects[0];

		expect(project.sessions).toHaveLength(MAX_OPEN_WITH_AO_SESSIONS);
		expect(project.sessions[0].id).toBe("worker-0");
		expect(project.sessions.some(({ id }) => id === "worker-58")).toBe(false);
		expect(project.moreCount).toBe(20);
		expect(isOpenWithAoSnapshot(result)).toBe(true);
	});

	it("keeps an old linked worker ahead of newer unlinked workers and prioritizes active workers", () => {
		const workers = Array.from({ length: 41 }, (_, index) => {
			const timestamp = new Date(Date.UTC(2026, 0, index + 2)).toISOString();
			return session(`new-${index}`, { createdAt: timestamp, lastUserMessageAt: timestamp });
		});
		workers.push(session("old-linked", {
			createdAt: "2025-01-01T00:00:00Z",
			lastUserMessageAt: "2025-01-01T00:00:00Z",
		}));
		const result = build([workspace("project-1", workers)], { links: [link("old-linked")] });

		expect(result.projects[0].sessions[0].id).toBe("old-linked");
		expect(result.projects[0].sessions).toHaveLength(MAX_OPEN_WITH_AO_SESSIONS);
		expect(result.projects[0].moreCount).toBe(2);
		expect(isOpenWithAoSnapshot(result)).toBe(true);
	});

	it("maps tone and state label from foundSessionEntry and clamps names", () => {
		const current = session("worker-1", {
			title: "x".repeat(MAX_OPEN_WITH_AO_NAME + 20),
			status: "ci_failed",
			prs: [{
				url: "https://github.com/acme/app/pull/1",
				number: 1,
				state: "open",
				ci: "failing",
				review: "changes_requested",
				mergeability: "unknown",
				reviewComments: false,
				updatedAt: "2026-01-01T00:00:00Z",
			}],
		});
		const result = build([workspace("project-1", [current], { name: "P".repeat(MAX_OPEN_WITH_AO_NAME + 20) })]);
		const expected = foundSessionEntry(current, t);
		const mapped = result.projects[0].sessions[0];

		expect(result.projects[0].name).toHaveLength(MAX_OPEN_WITH_AO_NAME);
		expect(mapped.label).toHaveLength(MAX_OPEN_WITH_AO_NAME);
		expect(mapped.tone).toBe(expected.tone);
		expect(mapped.stateLabel).toBe(expected.label);
		expect(mapped.detail).toBe(expected.detail);
		expect(isOpenWithAoSnapshot(result)).toBe(true);
	});

	it("sets terminated, updatedAt, stale, and daemon fields and skips invalid ids", () => {
		const result = build([
			workspace("project-1", [
				session("terminated-worker", { status: "terminated", isTerminated: true }),
				session("invalid-date", { updatedAt: "not-a-date" }),
				session(""),
				session("i".repeat(201)),
			]),
			workspace(""),
			workspace("p".repeat(201)),
		], { daemon: "starting", stale: true });
		const project = result.projects[0];

		expect(result.daemon).toBe("starting");
		expect(result.stale).toBe(true);
		expect(project.sessions.find(({ id }) => id === "terminated-worker")).toMatchObject({
			id: "terminated-worker",
			terminated: true,
			stale: true,
			updatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
		});
		expect(project.sessions.find(({ id }) => id === "invalid-date")?.updatedAt).toBe(0);
		expect(result.projects).toHaveLength(1);
		expect(isOpenWithAoSnapshot(result)).toBe(true);
	});

	it("does not count an orchestrator twice if its id also appears as a worker", () => {
		const result = build([workspace("project-1", [
			session("duplicate-id", { kind: "orchestrator" }),
			session("duplicate-id"),
		])]);

		expect(result.projects[0].orchestrator?.id).toBe("duplicate-id");
		expect(result.projects[0].sessions).toEqual([]);
		expect(isOpenWithAoSnapshot(result)).toBe(true);
	});

	it("does not publish duplicate worker ids", () => {
		const result = build([workspace("project-1", [session("duplicate-worker"), session("duplicate-worker")])]);

		expect(result.projects[0].sessions.map(({ id }) => id)).toEqual(["duplicate-worker"]);
		expect(result.projects[0].moreCount).toBe(1);
		expect(isOpenWithAoSnapshot(result)).toBe(true);
	});
});
