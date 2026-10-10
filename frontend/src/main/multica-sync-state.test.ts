// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	coerceMulticaSyncStateFile,
	createMulticaSyncStateStore,
	emptyMulticaSyncStateFile,
	MAX_MULTICA_SYNC_ISSUES,
	MAX_MULTICA_SYNC_LINKS,
	MULTICA_SYNC_STATE_FILE,
	type MulticaSyncStateFile,
} from "./multica-sync-state";

const known = { status: "in_progress", category: "in_progress", revision: 5, source: "write" as const, at: "2026-10-10T10:00:00.000Z" };

function sample(): MulticaSyncStateFile {
	return {
		settings: { enabled: true, moveOutOfBacklog: false },
		links: [{ serverKey: "cloud", sessionId: "s-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" }],
		issues: [
			{
				serverKey: "cloud",
				workspaceSlug: "acme",
				issueIdentifier: "MUL-1",
				lastKnown: known,
				pause: { reason: "changed_in_multica", target: "in_review", observedStatus: "todo", at: "2026-10-10T10:05:00.000Z" },
				lastSyncAt: "2026-10-10T10:06:00.000Z",
				orphaned: false,
			},
		],
	};
}

describe("multica sync state store", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-multica-sync-state-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	it("starts with everything off when the file is missing or damaged", async () => {
		const store = createMulticaSyncStateStore(stateDir);
		expect(await store.load()).toEqual(emptyMulticaSyncStateFile());
		expect(emptyMulticaSyncStateFile().settings).toEqual({ enabled: false, moveOutOfBacklog: false });

		await writeFile(path.join(stateDir, MULTICA_SYNC_STATE_FILE), "{");
		expect(await store.load()).toEqual(emptyMulticaSyncStateFile());
	});

	it("round-trips the state, writes it atomically with mode 0600 and leaves no temporary file", async () => {
		const store = createMulticaSyncStateStore(stateDir);
		await store.save(sample());

		expect(await createMulticaSyncStateStore(stateDir).load()).toEqual(sample());
		expect(await readdir(stateDir)).toEqual([MULTICA_SYNC_STATE_FILE]);
		if (process.platform !== "win32") {
			expect((await stat(path.join(stateDir, MULTICA_SYNC_STATE_FILE))).mode & 0o777).toBe(0o600);
		}
		expect(JSON.parse(await readFile(path.join(stateDir, MULTICA_SYNC_STATE_FILE), "utf8")).version).toBe(1);
	});

	it("serializes concurrent saves into valid JSON", async () => {
		const store = createMulticaSyncStateStore(stateDir);
		await Promise.all(
			Array.from({ length: 15 }, (_, index) => store.save({ ...sample(), settings: { enabled: index % 2 === 0, moveOutOfBacklog: true } })),
		);
		expect(JSON.parse(await readFile(path.join(stateDir, MULTICA_SYNC_STATE_FILE), "utf8")).settings.enabled).toBe(true);
	});
});

describe("coerceMulticaSyncStateFile", () => {
	it("rejects a wrong version or a non-object", () => {
		expect(coerceMulticaSyncStateFile({ version: 2, ...sample() })).toEqual(emptyMulticaSyncStateFile());
		expect(coerceMulticaSyncStateFile(null)).toEqual(emptyMulticaSyncStateFile());
		expect(coerceMulticaSyncStateFile([])).toEqual(emptyMulticaSyncStateFile());
	});

	it("reads a saved file with no Backlog setting as off, and keeps a saved on", () => {
		expect(coerceMulticaSyncStateFile({ version: 1, settings: { enabled: true } }).settings).toEqual({ enabled: true, moveOutOfBacklog: false });
		expect(coerceMulticaSyncStateFile({ version: 1, settings: { enabled: true, moveOutOfBacklog: true } }).settings.moveOutOfBacklog).toBe(true);
	});

	it("keeps only well-formed links and issues, once each", () => {
		const file = sample();
		const coerced = coerceMulticaSyncStateFile({
			version: 1,
			settings: { enabled: "yes", moveOutOfBacklog: 0 },
			links: [
				file.links[0],
				file.links[0],
				{ ...file.links[0], sessionId: "bad/id" },
				{ ...file.links[0], workspaceSlug: "Bad Slug" },
				{ ...file.links[0], serverKey: "" },
				{ ...file.links[0], issueIdentifier: "mul-1" },
				"nope",
			],
			issues: [
				file.issues[0],
				file.issues[0],
				{ ...file.issues[0], issueIdentifier: "MUL-2", lastKnown: { ...known, revision: 0 }, pause: { reason: "other", target: null, observedStatus: "x", at: "2026-10-10T10:05:00.000Z" } },
				{ ...file.issues[0], issueIdentifier: "bad" },
			],
		});

		expect(coerced.settings).toEqual({ enabled: false, moveOutOfBacklog: false });
		expect(coerced.links).toEqual([file.links[0]]);
		expect(coerced.issues).toHaveLength(2);
		expect(coerced.issues[0]).toEqual(file.issues[0]);
		expect(coerced.issues[1]).toMatchObject({ issueIdentifier: "MUL-2", lastKnown: null, pause: null });
	});

	it("only ever stores the writable statuses as a pause target", () => {
		const file = sample();
		const coerced = coerceMulticaSyncStateFile({
			version: 1,
			issues: [{ ...file.issues[0], pause: { ...file.issues[0].pause, target: "backlog" } }],
		});
		expect(coerced.issues[0].pause).toBeNull();
	});

	it("keeps a well-formed write intent and drops a damaged one", () => {
		const file = sample();
		const intent = { status: "in_review", category: "in_review", revBefore: 5, at: "2026-10-10T10:07:00.000Z" };
		const kept = coerceMulticaSyncStateFile({ version: 1, issues: [{ ...file.issues[0], intent }] });
		expect(kept.issues[0].intent).toEqual(intent);
		for (const bad of [{ ...intent, revBefore: 0 }, { ...intent, status: "" }, { ...intent, at: "no" }, "x", null]) {
			expect(coerceMulticaSyncStateFile({ version: 1, issues: [{ ...file.issues[0], intent: bad }] }).issues[0]).not.toHaveProperty("intent");
		}
	});

	it("is bounded", () => {
		const links = Array.from({ length: MAX_MULTICA_SYNC_LINKS + 3 }, (_, index) => ({
			serverKey: "cloud",
			sessionId: `s-${index}`,
			workspaceSlug: "acme",
			issueIdentifier: "MUL-1",
		}));
		const issues = Array.from({ length: MAX_MULTICA_SYNC_ISSUES + 3 }, (_, index) => ({
			serverKey: "cloud",
			workspaceSlug: "acme",
			issueIdentifier: `MUL-${index + 1}`,
			lastKnown: null,
			pause: null,
			lastSyncAt: null,
			orphaned: false,
		}));
		const coerced = coerceMulticaSyncStateFile({ version: 1, links, issues });
		expect(coerced.links).toHaveLength(MAX_MULTICA_SYNC_LINKS);
		expect(coerced.links[0].sessionId).toBe("s-3");
		expect(coerced.issues).toHaveLength(MAX_MULTICA_SYNC_ISSUES);
	});
});
