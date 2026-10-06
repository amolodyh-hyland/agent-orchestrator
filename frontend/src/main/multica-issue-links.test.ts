// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_MULTICA_ISSUE_LINKS, type MulticaIssueLink } from "../shared/multica-issue-links";
import { createMulticaIssueLinkStore, MULTICA_ISSUE_LINKS_FILE } from "./multica-issue-links";

describe("multica issue link store", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-multica-issue-links-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	it("lists an empty array when the file is missing", async () => {
		const store = createMulticaIssueLinkStore(stateDir);
		expect(await store.list()).toEqual([]);
	});

	it("persists links so a new store instance can read them", async () => {
		const store = createMulticaIssueLinkStore(stateDir);
		const expected = await store.add({
			sessionId: "session-1",
			projectId: "project-1",
			workspaceSlug: "acme",
			issueIdentifier: "MUL-1",
		});

		expect(await createMulticaIssueLinkStore(stateDir).list()).toEqual(expected);
		if (process.platform !== "win32") {
			const fileStat = await stat(path.join(stateDir, MULTICA_ISSUE_LINKS_FILE));
			expect(fileStat.mode & 0o777).toBe(0o600);
		}
	});

	it("creates a missing nested state directory when adding a link", async () => {
		const nestedStateDir = path.join(stateDir, "a", "b");
		const store = createMulticaIssueLinkStore(nestedStateDir);
		const expected = await store.add({
			sessionId: "session-1",
			projectId: "project-1",
			workspaceSlug: "acme",
			issueIdentifier: "MUL-1",
		});

		expect((await stat(nestedStateDir)).isDirectory()).toBe(true);
		expect(await createMulticaIssueLinkStore(nestedStateDir).list()).toEqual(expected);
	});

	it("keeps the original timestamp when the same key is added twice", async () => {
		let timestamp = 1_700_000_000_000;
		const store = createMulticaIssueLinkStore(stateDir, () => new Date(timestamp++));
		const link = {
			sessionId: "session-1",
			projectId: "project-1",
			workspaceSlug: "acme",
			issueIdentifier: "MUL-1",
		};

		const first = await store.add(link);
		const second = await store.add(link);

		expect(second).toEqual(first);
		expect(second).toHaveLength(1);
		expect(second[0].createdAt).toBe(new Date(1_700_000_000_000).toISOString());
	});

	it("removes only a matching link and leaves the file unchanged for a missing key", async () => {
		const store = createMulticaIssueLinkStore(stateDir);
		await store.add({ sessionId: "session-1", projectId: "project-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
		await store.add({ sessionId: "session-2", projectId: "project-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
		const file = path.join(stateDir, MULTICA_ISSUE_LINKS_FILE);
		const beforeMissingRemove = await readFile(file, "utf8");

		const remaining = await store.remove({ sessionId: "session-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
		expect(remaining.map((link) => link.sessionId)).toEqual(["session-2"]);
		const beforeSecondMissingRemove = await readFile(file, "utf8");
		expect(await store.remove({ sessionId: "missing", workspaceSlug: "acme", issueIdentifier: "MUL-1" })).toEqual(remaining);
		expect(await readFile(file, "utf8")).toBe(beforeSecondMissingRemove);
		expect(beforeMissingRemove).not.toBe(beforeSecondMissingRemove);
	});

	it("serializes concurrent additions and writes valid JSON", async () => {
		const store = createMulticaIssueLinkStore(stateDir);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				store.add({
					sessionId: `session-${index}`,
					projectId: "project-1",
					workspaceSlug: "acme",
					issueIdentifier: `MUL-${index + 1}`,
				}),
			),
		);

		expect(results.at(-1)).toHaveLength(20);
		const raw = await readFile(path.join(stateDir, MULTICA_ISSUE_LINKS_FILE), "utf8");
		expect(JSON.parse(raw).links).toHaveLength(20);
		expect(await store.list()).toHaveLength(20);
	});

	it("repairs a corrupt file on the next add", async () => {
		await writeFile(path.join(stateDir, MULTICA_ISSUE_LINKS_FILE), "{");
		const store = createMulticaIssueLinkStore(stateDir);
		expect(await store.list()).toEqual([]);

		const links = await store.add({ sessionId: "session-1", projectId: "project-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
		expect(links).toHaveLength(1);
		expect(JSON.parse(await readFile(path.join(stateDir, MULTICA_ISSUE_LINKS_FILE), "utf8")).links).toEqual(links);
	});

	it("drops invalid file entries and rejects invalid additions without changing the file", async () => {
		const valid: MulticaIssueLink = {
			sessionId: "session-1",
			projectId: "project-1",
			workspaceSlug: "acme",
			issueIdentifier: "MUL-1",
			createdAt: "2024-01-01T00:00:00.000Z",
		};
		const file = path.join(stateDir, MULTICA_ISSUE_LINKS_FILE);
		const original = JSON.stringify({ version: 1, links: [valid, { ...valid, sessionId: "bad/id" }] });
		await writeFile(file, original);
		const store = createMulticaIssueLinkStore(stateDir);

		expect(await store.list()).toEqual([valid]);
		await expect(
			store.add({ sessionId: "session-2", projectId: "project-1", workspaceSlug: "A B", issueIdentifier: "MUL-2" }),
		).rejects.toThrow("invalid link");
		expect(await store.list()).toEqual([valid]);
		expect(await readFile(file, "utf8")).toBe(original);
	});

	it("leaves no temporary files after repeated operations", async () => {
		const store = createMulticaIssueLinkStore(stateDir);
		await store.add({ sessionId: "session-1", projectId: "project-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
		await store.add({ sessionId: "session-2", projectId: "project-1", workspaceSlug: "acme", issueIdentifier: "MUL-2" });
		await store.remove({ sessionId: "session-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });

		expect(await readdir(stateDir)).toEqual([MULTICA_ISSUE_LINKS_FILE]);
	});

	it("keeps only the newest links when the maximum is exceeded", async () => {
		const existing = Array.from({ length: MAX_MULTICA_ISSUE_LINKS }, (_, index): MulticaIssueLink => ({
			sessionId: `session-${index}`,
			projectId: "project-1",
			workspaceSlug: "acme",
			issueIdentifier: `MUL-${index + 1}`,
			createdAt: "2024-01-01T00:00:00.000Z",
		}));
		await writeFile(path.join(stateDir, MULTICA_ISSUE_LINKS_FILE), `${JSON.stringify({ version: 1, links: existing }, null, 2)}\n`);
		const store = createMulticaIssueLinkStore(stateDir);

		const links = await store.add({
			sessionId: "session-newest",
			projectId: "project-1",
			workspaceSlug: "acme",
			issueIdentifier: "MUL-1001",
		});

		expect(links).toHaveLength(MAX_MULTICA_ISSUE_LINKS);
		expect(links[0].sessionId).toBe("session-1");
		expect(links.at(-1)?.sessionId).toBe("session-newest");
	});
});
