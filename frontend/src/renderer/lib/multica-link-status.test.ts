import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";
import {
	MAX_STATUS_DETAIL,
	MAX_STATUS_ENTRIES,
	MAX_STATUS_LABEL,
	isMulticaStatusSnapshot,
} from "../../shared/multica-session-status";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";
import { buildMulticaStatusSnapshot } from "./multica-link-status";

const t = ((key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key)) as TFunction;

function link(sessionId: string, projectId = "project-1"): MulticaIssueLink {
	return {
		sessionId,
		projectId,
		workspaceSlug: "acme",
		issueIdentifier: "MUL-1",
		createdAt: "2026-01-01T00:00:00Z",
	};
}

function session(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
	return {
		id: "session-1",
		workspaceId: "project-1",
		workspaceName: "Acme",
		title: "Fix the issue",
		provider: "claude-code",
		status: "working",
		updatedAt: "2026-01-01T00:00:00Z",
		prs: [],
		...overrides,
	};
}

function workspace(id: string, sessions: WorkspaceSession[]): WorkspaceSummary {
	return { id, name: id, path: "", sessions };
}

function pr(overrides: Partial<WorkspaceSession["prs"][number]> = {}): WorkspaceSession["prs"][number] {
	return {
		url: "https://github.com/acme/app/pull/12",
		number: 12,
		state: "open",
		ci: "unknown",
		review: "none",
		mergeability: "unknown",
		reviewComments: false,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function build(input: {
	links?: readonly MulticaIssueLink[];
	workspaces?: readonly WorkspaceSummary[];
	stale?: boolean;
	t?: TFunction;
}) {
	return buildMulticaStatusSnapshot({ links: [], workspaces: [], stale: false, t, ...input });
}

describe("buildMulticaStatusSnapshot", () => {
	it.each([
		["merged", "ready"],
		["ci_failed", "attention"],
		["review_pending", "pending"],
		["working", "working"],
		["terminated", "done"],
		["unknown", "unknown"],
	] as const)("maps %s status to its label and %s tone", (status, tone) => {
		const result = build({
			links: [link("session-1")],
			workspaces: [workspace("project-1", [session({ status })])],
		});

		expect(result.entries).toEqual([
			{ sessionId: "session-1", tone, label: `status.${status}`, detail: "" },
		]);
	});

	it("returns a not found entry when the project has no matching session", () => {
		expect(build({ links: [link("missing")] }).entries).toEqual([
			{ sessionId: "missing", tone: "unknown", label: "multica.status.notFound", detail: "" },
		]);
	});

	it("does not match a session found under a different project", () => {
		const result = build({
			links: [link("session-1", "project-1")],
			workspaces: [workspace("project-2", [session()])],
		});

		expect(result.entries[0]).toMatchObject({ tone: "unknown", label: "multica.status.notFound" });
	});

	it("uses only the first link for a distinct session id", () => {
		const result = build({
			links: [link("session-1", "project-1"), link("session-1", "project-2")],
			workspaces: [workspace("project-1", [session({ status: "merged" })]), workspace("project-2", [session({ status: "working" })])],
		});

		expect(result.entries).toEqual([
			{ sessionId: "session-1", tone: "ready", label: "status.merged", detail: "" },
		]);
	});

	it("deduplicates links to different issues in the same project", () => {
		const result = build({
			links: [
				{ ...link("session-1", "project-1"), issueIdentifier: "MUL-1" },
				{ ...link("session-1", "project-1"), issueIdentifier: "MUL-2" },
			],
			workspaces: [workspace("project-1", [session({ status: "working" })])],
		});

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]).toMatchObject({ sessionId: "session-1", tone: "working" });
	});

	it("includes open PR CI and review details", () => {
		const result = build({
			links: [link("session-1")],
			workspaces: [
				workspace("project-1", [session({ prs: [pr({ ci: "failing", review: "changes_requested" })] })]),
			],
		});

		expect(result.entries[0]?.detail).toBe(
			'multica.status.pr:{"number":12,"state":"pr.state.open"} · pr.section.ci: pr.ci.failing · pr.review.changesRequested',
		);
	});

	it("includes only the PR detail for a merged PR", () => {
		const result = build({
			links: [link("session-1")],
			workspaces: [workspace("project-1", [session({ prs: [pr({ state: "merged", ci: "failing", review: "changes_requested" })] })])],
		});

		expect(result.entries[0]?.detail).toBe('multica.status.pr:{"number":12,"state":"pr.state.merged"}');
	});

	it("clamps long PR details and returns a valid snapshot", () => {
		const longT = ((key: string) => (key === "multica.status.pr" ? "D".repeat(MAX_STATUS_DETAIL + 40) : key)) as TFunction;
		const result = build({
			links: [link("session-1")],
			workspaces: [workspace("project-1", [session({ prs: [pr()] })])],
			t: longT,
		});

		expect(result.entries[0]?.detail).toBe(`${"D".repeat(MAX_STATUS_DETAIL - 1)}…`);
		expect(isMulticaStatusSnapshot(result)).toBe(true);
	});

	it("uses the actionable primary PR and reports the remaining PR count", () => {
		const result = build({
			links: [link("session-1")],
			workspaces: [
				workspace(
					"project-1",
					[
						session({
							prs: [pr({ number: 4, state: "merged" }), pr({ number: 9, state: "open" })],
						}),
					],
				),
			],
		});

		expect(result.entries[0]?.detail).toBe(
			'multica.status.pr:{"number":9,"state":"pr.state.open"} multica.status.prMore:{"count":1}',
		);
	});

	it("omits detail without PRs and omits unknown CI values", () => {
		const noPr = build({
			links: [link("session-1")],
			workspaces: [workspace("project-1", [session()])],
		});
		const unknownCi = build({
			links: [link("session-1")],
			workspaces: [workspace("project-1", [session({ prs: [pr({ ci: "unknown" })] })])],
		});

		expect(noPr.entries[0]?.detail).toBe("");
		expect(unknownCi.entries[0]?.detail).toBe('multica.status.pr:{"number":12,"state":"pr.state.open"}');
	});

	it("folds stale state into every label while preserving tones", () => {
		const result = build({
			links: [link("session-1"), link("missing")],
			workspaces: [workspace("project-1", [session({ status: "merged" })])],
			stale: true,
		});

		expect(result).toEqual({
			stale: true,
			entries: [
				{ sessionId: "session-1", tone: "ready", label: 'multica.status.stale:{"status":"status.merged"}', detail: "" },
				{ sessionId: "missing", tone: "unknown", label: 'multica.status.stale:{"status":"multica.status.notFound"}', detail: "" },
			],
		});
	});

	it("clamps long labels and skips invalid session ids", () => {
		const longT = ((key: string) => (key.startsWith("status.") ? "L".repeat(100) : key)) as TFunction;
		const result = build({
			links: [link("session-1"), link(""), link("x".repeat(201))],
			workspaces: [workspace("project-1", [session()])],
			t: longT,
		});

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.label).toBe(`${"L".repeat(MAX_STATUS_LABEL - 1)}…`);
	});

	it("caps entries and returns an empty snapshot for no links", () => {
		const links = Array.from({ length: MAX_STATUS_ENTRIES + 5 }, (_, index) => link(`session-${index}`));

		expect(build({ links }).entries).toHaveLength(MAX_STATUS_ENTRIES);
		expect(build({ links: [] }).entries).toEqual([]);
	});
});
