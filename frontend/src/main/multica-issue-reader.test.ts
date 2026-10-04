// @vitest-environment node
import { runInNewContext, Script } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildReadIssueScript,
	parseReadIssueResult,
	READ_ISSUE_TIMEOUT_MS,
	type ReadIssueResult,
} from "./multica-issue-reader";

const API_URL = "https://api.example.com/";
const IDENTIFIER = "MUL-123";

function evaluateReadIssue(
	input: { apiUrl?: string; identifier?: string; token?: string | null; tabs?: string | null; fetch?: ReturnType<typeof vi.fn> },
): Promise<unknown> {
	const script = buildReadIssueScript({ apiUrl: input.apiUrl ?? API_URL, identifier: input.identifier ?? IDENTIFIER });
	return runInNewContext(script, {
		localStorage: {
			getItem: (key: string) => {
				if (key === "multica_token") return input.token ?? null;
				if (key === "multica_tabs") return input.tabs === undefined ? '{"state":{"activeWorkspaceSlug":"acme"}}' : input.tabs;
				return null;
			},
		},
		fetch: input.fetch ?? vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ identifier: IDENTIFIER, title: "Fix the bug", description: "Details" }) }),
		AbortController,
		setTimeout,
		clearTimeout,
		JSON,
		encodeURIComponent,
		Promise,
		Error,
	});
}

function response(status: number, data: unknown): { status: number; ok: boolean; json: () => Promise<unknown> } {
	return { status, ok: status >= 200 && status < 300, json: async () => data };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("multica issue reader", () => {
	it("builds a valid async script", () => {
		const script = buildReadIssueScript({ apiUrl: API_URL, identifier: IDENTIFIER });

		expect(() => new Script(script)).not.toThrow();
		expect(script.startsWith("(async () => {")).toBe(true);
	});

	it("returns signed out without calling fetch when there is no token", async () => {
		const fetch = vi.fn();

		const raw = await evaluateReadIssue({ fetch });

		expect(parseReadIssueResult(raw)).toEqual({ ok: false, reason: "signed_out" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([null, "{", "{}", '{"state":{}}'])("returns no workspace for tabs value %s", async (tabs) => {
		const fetch = vi.fn();

		const raw = await evaluateReadIssue({ token: "tok-secret", tabs, fetch });

		expect(parseReadIssueResult(raw)).toEqual({ ok: false, reason: "no_workspace" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reads an issue using the page token and active workspace", async () => {
		const fetch = vi.fn().mockResolvedValue(response(200, { identifier: IDENTIFIER, title: "Fix the bug", description: "Details" }));

		const raw = await evaluateReadIssue({ token: "tok-secret", fetch });

		expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.example.com/api/issues/MUL-123", {
			method: "GET",
			headers: { Authorization: "Bearer tok-secret", "X-Workspace-Slug": "acme" },
			credentials: "omit",
			signal: expect.anything(),
		});
		expect(parseReadIssueResult(raw)).toEqual({
			ok: true,
			workspaceSlug: "acme",
			issueIdentifier: IDENTIFIER,
			title: "Fix the bug",
			description: "Details",
		} satisfies ReadIssueResult);
		expect(String(raw)).not.toContain("tok-secret");
	});

	it("uses an empty description when the issue description is null", async () => {
		const raw = await evaluateReadIssue({ token: "tok-secret", fetch: vi.fn().mockResolvedValue(response(200, { identifier: IDENTIFIER, title: "Fix the bug", description: null })) });

		expect(parseReadIssueResult(raw)).toEqual({
			ok: true,
			workspaceSlug: "acme",
			issueIdentifier: IDENTIFIER,
			title: "Fix the bug",
			description: "",
		});
	});

	it("uses an empty description when the issue description is missing", async () => {
		const raw = await evaluateReadIssue({ token: "tok-secret", fetch: vi.fn().mockResolvedValue(response(200, { identifier: IDENTIFIER, title: "Fix the bug" })) });

		expect(parseReadIssueResult(raw)).toEqual({
			ok: true,
			workspaceSlug: "acme",
			issueIdentifier: IDENTIFIER,
			title: "Fix the bug",
			description: "",
		});
	});

	it.each([401, 404, 500])("maps HTTP status %s", async (status) => {
		const raw = await evaluateReadIssue({ token: "tok-secret", fetch: vi.fn().mockResolvedValue(response(status, {})) });

		expect(parseReadIssueResult(raw)).toEqual({ ok: false, reason: status === 401 ? "signed_out" : "unreadable" });
	});

	it("maps rejected fetch and JSON parsing to unreadable", async () => {
		const fetchFailure = await evaluateReadIssue({ token: "tok-secret", fetch: vi.fn().mockRejectedValue(new Error("fetch failed")) });
		const jsonFailure = await evaluateReadIssue({
			token: "tok-secret",
			fetch: vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => Promise.reject(new Error("invalid JSON")) }),
		});

		expect(parseReadIssueResult(fetchFailure)).toEqual({ ok: false, reason: "unreadable" });
		expect(parseReadIssueResult(jsonFailure)).toEqual({ ok: false, reason: "unreadable" });
	});

	it.each([{ title: "Missing identifier" }, { identifier: IDENTIFIER }])("maps a body without identifier or title to unreadable", async (data) => {
		const raw = await evaluateReadIssue({ token: "tok-secret", fetch: vi.fn().mockResolvedValue(response(200, data)) });

		expect(parseReadIssueResult(raw)).toEqual({ ok: false, reason: "unreadable" });
	});

	it.each([{}, 1, [], true])("maps a malformed description to unreadable: %s", async (description) => {
		const raw = await evaluateReadIssue({
			token: "tok-secret",
			fetch: vi.fn().mockResolvedValue(response(200, { identifier: IDENTIFIER, title: "Fix the bug", description })),
		});

		expect(parseReadIssueResult(raw)).toEqual({ ok: false, reason: "unreadable" });
	});

	it("aborts a fetch that exceeds the timeout", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn((_url: string, init: { signal: AbortSignal }) =>
			new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
		);
		const pending = evaluateReadIssue({ token: "tok-secret", fetch });

		await vi.advanceTimersByTimeAsync(READ_ISSUE_TIMEOUT_MS);
		const raw = await pending;

		expect(parseReadIssueResult(raw)).toEqual({ ok: false, reason: "unreadable" });
	});

	it("safely embeds quoted issue identifiers and API URLs", async () => {
		const identifier = 'A"B</script>\n';
		const apiUrl = 'https://api.example.com/"quoted/';
		const fetch = vi.fn().mockResolvedValue(response(200, { identifier, title: "Quoted", description: "" }));
		const script = buildReadIssueScript({ apiUrl, identifier });

		expect(() => new Script(script)).not.toThrow();
		const raw = await evaluateReadIssue({ apiUrl, identifier, token: "tok-secret", fetch });

		expect(fetch.mock.calls[0]?.[0]).toBe('https://api.example.com/"quoted/api/issues/A%22B%3C%2Fscript%3E%0A');
		expect(parseReadIssueResult(raw)).toEqual({
			ok: true,
			workspaceSlug: "acme",
			issueIdentifier: identifier,
			title: "Quoted",
			description: "",
		});
	});
});

describe("parseReadIssueResult", () => {
	it("parses valid success and failure results", () => {
		expect(parseReadIssueResult(JSON.stringify({ ok: true, workspaceSlug: "acme", issueIdentifier: "MUL-123", title: "Fix", description: "Details" }))).toEqual({
			ok: true,
			workspaceSlug: "acme",
			issueIdentifier: "MUL-123",
			title: "Fix",
			description: "Details",
		});
		expect(parseReadIssueResult('{"ok":false,"reason":"signed_out"}')).toEqual({ ok: false, reason: "signed_out" });
	});

	it.each([undefined, 1, "{", '{"ok":true}', '{"ok":false,"reason":"other"}'])("returns unreadable for invalid result %s", (raw) => {
		expect(parseReadIssueResult(raw)).toEqual({ ok: false, reason: "unreadable" });
	});
});
