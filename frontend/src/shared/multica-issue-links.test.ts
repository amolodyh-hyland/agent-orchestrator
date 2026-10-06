import { describe, expect, it } from "vitest";
import {
	aoSessionUrl,
	coerceMulticaIssueLinks,
	isMulticaIssueLink,
	isMulticaIssuePath,
	MAX_MULTICA_ISSUE_LINKS,
	multicaIssuePath,
	parseAoSessionUrl,
	parseMulticaIssueRef,
	parseMulticaIssueTitle,
	STANDALONE_PROJECT_ID,
	type MulticaIssueLink,
} from "./multica-issue-links";

describe("parseMulticaIssueRef", () => {
	it.each([
		"https://multica.example.com/acme/issues/MUL-123",
		"http://localhost:3000/acme/issues/mul-123/?x=1#comment-9",
		"/acme/issues/MUL-123",
		"acme/issues/MUL-123/",
	])("parses %s", (input) => {
		expect(parseMulticaIssueRef(input)).toEqual({ workspaceSlug: "acme", issueIdentifier: "MUL-123" });
	});

	it.each([
		["bare identifier", "MUL-123"],
		["UUID issue id", "/acme/issues/550e8400-e29b-41d4-a716-446655440000"],
		["missing issue id", "/acme/issues/"],
		["extra path segment", "/acme/issues/MUL-123/extra"],
		["uppercase issues segment", "/acme/Issues/MUL-123"],
		["script scheme", "javascript:alert(1)"],
		["AO scheme", "ao://sessions/p/s"],
		["embedded credentials", "https://user:pw@host/acme/issues/MUL-1"],
		["empty input", ""],
		["oversized input", "a".repeat(3000)],
		["number", 42],
		["null", null],
		["malformed escape", "/acme/issues/MUL-%ZZ"],
	])("rejects %s", (_name, input) => {
		expect(parseMulticaIssueRef(input)).toBeNull();
	});

	it("normalizes the workspace slug and issue identifier", () => {
		expect(parseMulticaIssueRef("/Acme_Team/issues/mul-1")).toEqual({
			workspaceSlug: "acme_team",
			issueIdentifier: "MUL-1",
		});
	});

	it("accepts a prefix that starts with a digit and upper-cases its output", () => {
		expect(parseMulticaIssueRef("https://multica.example.com/acme/issues/1team-123")).toEqual({
			workspaceSlug: "acme",
			issueIdentifier: "1TEAM-123",
		});
		expect(parseMulticaIssueRef("/acme/issues/1TEAM-123")).toEqual({
			workspaceSlug: "acme",
			issueIdentifier: "1TEAM-123",
		});
		expect(parseMulticaIssueRef("/acme/issues/ABCDEFGHIJ-1")).toEqual({
			workspaceSlug: "acme",
			issueIdentifier: "ABCDEFGHIJ-1",
		});
		expect(parseMulticaIssueRef("/acme/issues/MUL-123456789")).toEqual({
			workspaceSlug: "acme",
			issueIdentifier: "MUL-123456789",
		});
	});

	it("accepts 63-character workspace slugs and rejects 64-character slugs", () => {
		expect(parseMulticaIssueRef(`/${"a".repeat(63)}/issues/MUL-1`)).not.toBeNull();
		expect(parseMulticaIssueRef(`/${"a".repeat(64)}/issues/MUL-1`)).toBeNull();
	});

	it.each(["MUL-0", "MUL-01", "MUL-1234567890", "ABCDEFGHIJK-1"])("rejects out-of-range issue identifier %s", (identifier) => {
		expect(parseMulticaIssueRef(`/acme/issues/${identifier}`)).toBeNull();
	});
});

describe("Multica issue paths", () => {
	it("round-trips a parsed issue reference", () => {
		const ref = { workspaceSlug: "acme", issueIdentifier: "MUL-1" };
		const path = multicaIssuePath(ref);
		expect(path).toBe("/acme/issues/MUL-1");
		expect(isMulticaIssuePath(path)).toBe(true);
	});

	it("accepts digit-first identifiers and ten-character prefixes", () => {
		expect(isMulticaIssuePath("/acme/issues/1TEAM-123")).toBe(true);
		expect(isMulticaIssuePath("/acme/issues/ABCDEFGHIJ-1")).toBe(true);
		expect(isMulticaIssuePath("/acme/issues/MUL-123456789")).toBe(true);
	});

	it.each([
		"/acme/issues/mul-1",
		"/acme/issues/MUL-1?x",
		"/acme/issues/MUL-1/",
		"/acme/issues/ABCDEFGHIJK-1",
		"/acme/issues/MUL-1234567890",
		"/acme/issues/MUL-0",
		"/acme/issues/MUL-01",
		"//acme/issues/MUL-1",
		"acme/issues/MUL-1",
		42,
		null,
	])("rejects non-canonical path %s", (path) => {
		expect(isMulticaIssuePath(path)).toBe(false);
	});
});

describe("parseMulticaIssueTitle", () => {
	const cases: Array<[unknown, string | null]> = [
		["Issue", null],
		["MUL-123 Fix", null],
		["mul-1: x", "MUL-1"],
		["1TEAM-123: x", "1TEAM-123"],
		["ABCDEFGHIJ-1: x", "ABCDEFGHIJ-1"],
		["ABCDEFGHIJK-1: x", null],
		["MUL-123456789: x", "MUL-123456789"],
		["MUL-1234567890: x", null],
		["MUL-0: x", null],
		["MUL-01: x", null],
		[": x", null],
		["MUL-123: ", "MUL-123"],
		[42, null],
		[null, null],
	];

	it.each(cases)("parses title %s", (title, expected) => {
		expect(parseMulticaIssueTitle(title)).toBe(expected);
	});
});

describe("AO session URLs", () => {
	it("encodes values and round-trips ids with spaces", () => {
		const url = aoSessionUrl("project id", "session id");
		expect(url).toBe("ao://sessions/project%20id/session%20id");
		expect(parseAoSessionUrl(url)).toEqual({ projectId: "project id", sessionId: "session id" });
	});

	it("uses the standalone project id", () => {
		const url = aoSessionUrl(STANDALONE_PROJECT_ID, "session-1");
		expect(parseAoSessionUrl(url)).toEqual({ projectId: STANDALONE_PROJECT_ID, sessionId: "session-1" });
	});

	it("encodes slash characters but does not accept decoded slashes", () => {
		expect(aoSessionUrl("project/one", "session/two")).toBe("ao://sessions/project%2Fone/session%2Ftwo");
		expect(parseAoSessionUrl(aoSessionUrl("project/one", "session/two"))).toBeNull();
	});

	it.each([
		"ao://sessions/p",
		"ao://sessions/p/s/x",
		"ao://sessions/p/s?x=1",
		"ao://sessions/p/s#x",
		"ao://sessions//s",
		"https://x/p/s",
		"ao://sessions/%2F/s",
		"ao://sessions/%ZZ/s",
		42,
		null,
	])("rejects invalid URL %s", (url) => {
		expect(parseAoSessionUrl(url)).toBeNull();
	});
});

describe("Multica issue link records", () => {
	const link = (overrides: Partial<MulticaIssueLink> = {}): MulticaIssueLink => ({
		sessionId: "session-1",
		projectId: "project-1",
		workspaceSlug: "acme",
		issueIdentifier: "MUL-1",
		createdAt: "2025-01-02T03:04:05.000Z",
		...overrides,
	});

	it("validates fields and accepted timestamps", () => {
		expect(isMulticaIssueLink(link())).toBe(true);
		expect(isMulticaIssueLink(link({ issueIdentifier: "1TEAM-123" }))).toBe(true);
		expect(isMulticaIssueLink(link({ issueIdentifier: "ABCDEFGHIJ-1" }))).toBe(true);
		expect(isMulticaIssueLink(link({ issueIdentifier: "MUL-123456789" }))).toBe(true);
		expect(isMulticaIssueLink(link({ issueIdentifier: "ABCDEFGHIJK-1" }))).toBe(false);
		expect(isMulticaIssueLink(link({ issueIdentifier: "MUL-1234567890" }))).toBe(false);
		expect(isMulticaIssueLink(link({ issueIdentifier: "MUL-0" }))).toBe(false);
		expect(isMulticaIssueLink(link({ issueIdentifier: "MUL-01" }))).toBe(false);
		expect(isMulticaIssueLink(link({ sessionId: "   " }))).toBe(false);
		expect(isMulticaIssueLink(link({ projectId: `${"p".repeat(200)}p` }))).toBe(false);
		expect(isMulticaIssueLink(link({ sessionId: "session/1" }))).toBe(false);
		expect(isMulticaIssueLink(link({ sessionId: "session\u0001" }))).toBe(false);
		expect(isMulticaIssueLink(link({ workspaceSlug: "Acme" }))).toBe(false);
		expect(isMulticaIssueLink(link({ issueIdentifier: "mul-1" }))).toBe(false);
		expect(isMulticaIssueLink(link({ createdAt: "not a date" }))).toBe(false);
	});

	it("keeps valid file links, drops invalid records and keeps the first duplicate", () => {
		const first = link();
		const duplicate = link({ projectId: "project-2", createdAt: "2025-02-03T00:00:00Z" });
		const differentIssue = link({ issueIdentifier: "MUL-2" });
		expect(coerceMulticaIssueLinks({ version: 1, links: [first, { ...first, sessionId: "bad/1" }, duplicate, differentIssue] })).toEqual([
			first,
			differentIssue,
		]);
	});

	it.each([
		["wrong version", { version: 2, links: [link()] }],
		["array", [link()]],
		["null", null],
		["missing links", { version: 1 }],
		["non-array links", { version: 1, links: {} }],
	])("returns no links for %s", (_name, raw) => {
		expect(coerceMulticaIssueLinks(raw)).toEqual([]);
	});

	it("keeps only the last maximum number of valid unique links", () => {
		const links = Array.from({ length: MAX_MULTICA_ISSUE_LINKS + 5 }, (_, index) =>
			link({ sessionId: `session-${index}`, issueIdentifier: `MUL-${index + 1}` }),
		);
		const result = coerceMulticaIssueLinks({ version: 1, links });
		expect(result).toHaveLength(MAX_MULTICA_ISSUE_LINKS);
		expect(result[0]).toEqual(links[5]);
		expect(result[result.length - 1]).toEqual(links[links.length - 1]);
	});
});
