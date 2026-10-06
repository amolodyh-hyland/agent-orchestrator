import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { WorkspaceSession } from "../types/workspace";
import { foundSessionEntry } from "./multica-link-status";

const t = ((key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key)) as TFunction;

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

describe("foundSessionEntry", () => {
	it.each([
		["merged", "ready"],
		["ci_failed", "attention"],
		["review_pending", "pending"],
		["working", "working"],
		["terminated", "done"],
		["unknown", "unknown"],
	] as const)("maps %s status to its label and %s tone", (status, tone) => {
		expect(foundSessionEntry(session({ status }), t)).toEqual({
			sessionId: "session-1",
			tone,
			label: `status.${status}`,
			detail: "",
		});
	});

	it("includes open PR CI and review details", () => {
		expect(foundSessionEntry(session({ prs: [pr({ ci: "failing", review: "changes_requested" })] }), t).detail).toBe(
			'multica.status.pr:{"number":12,"state":"pr.state.open"} · pr.section.ci: pr.ci.failing · pr.review.changesRequested',
		);
	});

	it("includes only the PR detail for a merged PR", () => {
		expect(foundSessionEntry(session({ prs: [pr({ state: "merged", ci: "failing", review: "changes_requested" })] }), t).detail).toBe(
			'multica.status.pr:{"number":12,"state":"pr.state.merged"}',
		);
	});

	it("uses the actionable primary PR and reports the remaining PR count", () => {
		const entry = foundSessionEntry(
			session({ prs: [pr({ number: 4, state: "merged" }), pr({ number: 9, state: "open" })] }),
			t,
		);

		expect(entry.detail).toBe('multica.status.pr:{"number":9,"state":"pr.state.open"} multica.status.prMore:{"count":1}');
	});

	it("omits detail without PRs and omits unknown CI values", () => {
		expect(foundSessionEntry(session(), t).detail).toBe("");
		expect(foundSessionEntry(session({ prs: [pr({ ci: "unknown" })] }), t).detail).toBe(
			'multica.status.pr:{"number":12,"state":"pr.state.open"}',
		);
	});
});
