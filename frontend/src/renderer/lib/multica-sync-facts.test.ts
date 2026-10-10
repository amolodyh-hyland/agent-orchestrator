import { describe, expect, it } from "vitest";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import { isMulticaSyncFacts, MAX_MULTICA_SYNC_FACT_SESSIONS } from "../../shared/multica-status-sync";
import type { PullRequestFacts, WorkspaceSession, WorkspaceSummary } from "../types/workspace";
import { buildMulticaSyncFacts, syncFactsOf } from "./multica-sync-facts";

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

function pr(state: PullRequestFacts["state"], number = 1): PullRequestFacts {
	return { url: `https://github.com/acme/app/pull/${number}`, number, state, ci: "passing", review: "none", mergeability: "mergeable", reviewComments: false, updatedAt: "2026-01-01T00:00:00.000Z" };
}

function link(sessionId: string): MulticaIssueLink {
	return { sessionId, projectId: "project-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", createdAt: "2026-01-01T00:00:00.000Z" };
}

const workspace = (sessions: WorkspaceSession[], id = "project-1"): WorkspaceSummary => ({ id, name: id, path: "", sessions });

describe("syncFactsOf", () => {
	it("reduces a session to the facts the mapper needs", () => {
		expect(
			syncFactsOf(
				session("s-1", {
					kanbanColumn: "needs_review",
					activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00.000Z" },
					provisionState: "ready",
					prs: [pr("open", 1), pr("merged", 2)],
				}),
			),
		).toEqual({ sessionId: "s-1", provisioning: "ready", column: "needs_review", activity: "idle", terminated: false, prs: ["open", "merged"] });
	});

	it("treats a missing provision state as ready, a missing activity as unknown and a missing column as the one the status implies", () => {
		expect(syncFactsOf(session("s-1"))).toMatchObject({ provisioning: "ready", activity: "unknown", column: "building" });
		expect(syncFactsOf(session("s-1", { status: "review_pending" }))).toMatchObject({ column: "validating" });
		expect(syncFactsOf(session("s-1", { status: "changes_requested" }))).toMatchObject({ column: "needs_review" });
		expect(syncFactsOf(session("s-1", { status: "mergeable" }))).toMatchObject({ column: "ready" });
	});

	it("reports provisioning and failed starts, and terminated sessions by the durable flag or the status", () => {
		expect(syncFactsOf(session("s-1", { provisionState: "provisioning" })).provisioning).toBe("provisioning");
		expect(syncFactsOf(session("s-1", { provisionState: "failed" })).provisioning).toBe("failed");
		expect(syncFactsOf(session("s-1", { isTerminated: true })).terminated).toBe(true);
		expect(syncFactsOf(session("s-1", { status: "terminated" })).terminated).toBe(true);
	});

	it("never produces anything the IPC validator refuses", () => {
		const sessions = [
			session("a", { activity: { state: "waiting_input", lastActivityAt: "x" } }),
			session("b", { kanbanColumn: "archive", isTerminated: true, prs: [pr("closed")] }),
			session("c", { activity: { state: "weird" as never, lastActivityAt: "x" }, kanbanColumn: "odd" as never }),
		];
		expect(isMulticaSyncFacts({ stale: false, sessions: sessions.map(syncFactsOf) })).toBe(true);
	});
});

describe("buildMulticaSyncFacts", () => {
	it("includes only linked sessions, once each, across projects", () => {
		const result = buildMulticaSyncFacts({
			workspaces: [workspace([session("linked"), session("other")]), workspace([session("linked"), session("second")], "project-2")],
			links: [link("linked"), link("second"), link("missing")],
			stale: false,
		});

		expect(result.sessions.map((entry) => entry.sessionId)).toEqual(["linked", "second"]);
		expect(result.stale).toBe(false);
	});

	it("marks stale facts", () => {
		expect(buildMulticaSyncFacts({ workspaces: [], links: [], stale: true })).toEqual({ stale: true, sessions: [] });
	});

	it("is bounded", () => {
		const sessions = Array.from({ length: MAX_MULTICA_SYNC_FACT_SESSIONS + 5 }, (_, index) => session(`s-${index}`));
		const result = buildMulticaSyncFacts({ workspaces: [workspace(sessions)], links: sessions.map((entry) => link(entry.id)), stale: false });
		expect(result.sessions).toHaveLength(MAX_MULTICA_SYNC_FACT_SESSIONS);
		expect(isMulticaSyncFacts(result)).toBe(true);
	});
});
