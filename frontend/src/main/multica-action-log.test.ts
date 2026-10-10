import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MulticaActionInput } from "../shared/multica-action-log";
import { createMulticaActionLog, getMulticaActionLog, MULTICA_ACTION_LOG_FILE } from "./multica-action-log";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "ao-action-log-"));
});

afterEach(async () => {
	await chmod(dir, 0o700).catch(() => undefined);
	await rm(dir, { recursive: true, force: true });
});

const base: MulticaActionInput = { kind: "status_write", direction: "ao_to_multica", actor: "policy" };

async function lines(file = MULTICA_ACTION_LOG_FILE): Promise<unknown[]> {
	const raw = await readFile(path.join(dir, file), "utf8");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("multica action log record()", () => {
	it("writes one JSON line per call with the documented fields, mode 0600", async () => {
		const log = createMulticaActionLog(dir, { now: () => new Date("2026-10-10T10:00:00Z"), createId: () => "id-1" });
		await log.record({
			...base,
			serverKey: "cloud",
			workspaceId: "ws-1",
			issueId: "iss-1",
			identifier: "MUL-12",
			title: "Fix the board",
			trigger: "issue:updated r7",
			request: { method: "put", path: "/api/issues/{id}", fields: { status: "in_progress", suppress_run: true } },
			result: { ok: true, httpStatus: 200 },
			revBefore: 6,
			revAfter: 7,
			sessionId: "s-12",
		});
		expect(await lines()).toEqual([
			{
				v: 1,
				id: "id-1",
				ts: "2026-10-10T10:00:00.000Z",
				kind: "status_write",
				direction: "ao_to_multica",
				actor: "policy",
				serverKey: "cloud",
				workspaceId: "ws-1",
				issueId: "iss-1",
				identifier: "MUL-12",
				title80: "Fix the board",
				trigger: "issue:updated r7",
				request: { method: "PUT", path: "/api/issues/{id}", fields: { status: "in_progress", suppress_run: true } },
				result: { ok: true, httpStatus: 200 },
				revBefore: 6,
				revAfter: 7,
				sessionId: "s-12",
			},
		]);
		expect((await stat(path.join(dir, MULTICA_ACTION_LOG_FILE))).mode & 0o777).toBe(0o600);
	});

	it("drops secrets, descriptions, comments, prompts, frames and work_dir passed by mistake", async () => {
		const log = createMulticaActionLog(dir);
		await log.record({
			...base,
			token: "mul_supersecrettokenvalue",
			authorization: "Bearer abcdefghijklmnop",
			description: "private description text",
			comment: "private comment text",
			prompt: "private prompt text",
			work_dir: "/Users/someone/work",
			frame: { type: "issue:updated", payload: { description: "leaked" } },
			request: {
				method: "PUT",
				path: "/api/issues/{id}",
				fields: { status: "done", description: "private description text", title: "secret title text" },
			},
		} as MulticaActionInput);
		const raw = await readFile(path.join(dir, MULTICA_ACTION_LOG_FILE), "utf8");
		for (const leaked of ["supersecret", "abcdefghijklmnop", "private", "work_dir", "/Users/someone", "leaked", "secret title"]) {
			expect(raw).not.toContain(leaked);
		}
		const [entry] = (await lines()) as Array<{ request: { fields: Record<string, unknown> } }>;
		// Free-text request fields are logged by name only, scalar fields on the allow-list keep their value.
		expect(entry.request.fields).toEqual({ status: "done", description: null, title: null });
	});

	it("redacts credential-shaped strings inside permitted fields", async () => {
		const log = createMulticaActionLog(dir);
		await log.record({
			...base,
			title: "see mul_abcdefghijklmnop and mat_zzzzzzzzzzzz",
			trigger: "Bearer abcdefghijklmnopqrstuvwxyz.012345",
			clientRequestId: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
			result: { ok: false, code: "mdt_0123456789abcdef" },
		});
		const raw = await readFile(path.join(dir, MULTICA_ACTION_LOG_FILE), "utf8");
		expect(raw).not.toMatch(/mul_abc|mat_zzz|mdt_0123|Bearer abc|eyJhbGci/);
		expect(raw).toContain("[redacted]");
	});

	it("cuts the title to 80 characters and strips control characters", async () => {
		const log = createMulticaActionLog(dir);
		await log.record({ ...base, title: `${"a".repeat(120)}` });
		await log.record({ ...base, title: "line one\nline two\u0007" });
		const [first, second] = (await lines()) as Array<{ title80: string }>;
		expect(Array.from(first.title80)).toHaveLength(80);
		expect(second.title80).toBe("line one line two");
	});

	it("rotates at the size cap, keeps five files in total and drops the oldest", async () => {
		const log = createMulticaActionLog(dir, { maxBytes: 600, maxFiles: 5 });
		for (let index = 0; index < 60; index += 1) {
			await log.record({ ...base, identifier: `MUL-${index}`, trigger: "x".repeat(40) });
		}
		const files = (await readdir(dir)).filter((name) => name.startsWith(MULTICA_ACTION_LOG_FILE)).sort();
		expect(files).toEqual([
			MULTICA_ACTION_LOG_FILE,
			`${MULTICA_ACTION_LOG_FILE}.1`,
			`${MULTICA_ACTION_LOG_FILE}.2`,
			`${MULTICA_ACTION_LOG_FILE}.3`,
			`${MULTICA_ACTION_LOG_FILE}.4`,
		]);
		for (const name of files) expect((await stat(path.join(dir, name))).size).toBeLessThanOrEqual(600);
		const all = await log.read({ limit: 500 });
		// Newest first, the earliest entries are gone, no gaps inside the kept window.
		expect(all[0].identifier).toBe("MUL-59");
		const numbers = all.map((entry) => Number(entry.identifier?.replace("MUL-", "")));
		expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
		expect(numbers.at(-1)).toBeGreaterThan(0);
		for (let index = 1; index < numbers.length; index += 1) expect(numbers[index - 1] - numbers[index]).toBe(1);
		for (const name of files) expect((await stat(path.join(dir, name))).mode & 0o777).toBe(0o600);
	});

	it("continues the size count of an existing file after a restart", async () => {
		await writeFile(path.join(dir, MULTICA_ACTION_LOG_FILE), `${"{}\n".repeat(150)}`, { mode: 0o600 });
		const log = createMulticaActionLog(dir, { maxBytes: 460 });
		await log.record({ ...base, identifier: "MUL-1" });
		expect((await readdir(dir)).sort()).toEqual([MULTICA_ACTION_LOG_FILE, `${MULTICA_ACTION_LOG_FILE}.1`]);
	});

	it("never rejects when the log cannot be written", async () => {
		const blocker = path.join(dir, "not-a-directory");
		await writeFile(blocker, "x");
		const log = createMulticaActionLog(blocker);
		await expect(log.record(base)).resolves.toBeUndefined();
	});

	it("writes a connection lifecycle line once per state change", async () => {
		const log = createMulticaActionLog(dir);
		const connect = { kind: "connect", direction: "local", actor: "system", serverKey: "cloud", workspaceId: "w", result: { ok: true } } as const;
		await log.record(connect);
		await log.record(connect);
		await log.record({ ...connect, kind: "disconnect" });
		await log.record(connect);
		expect((await lines()).map((entry) => (entry as { kind: string }).kind)).toEqual(["connect", "disconnect", "connect"]);
	});

	it("reads newest first and filters by issue and kind, ignoring malformed lines", async () => {
		const log = createMulticaActionLog(dir);
		await log.record({ ...base, issueId: "a", kind: "status_write" });
		await log.record({ ...base, issueId: "b", kind: "pause" });
		await log.record({ ...base, issueId: "a", kind: "resume" });
		await writeFile(path.join(dir, MULTICA_ACTION_LOG_FILE), `not json\n{"v":2}\n`, { flag: "a" });
		expect((await log.read({ issueId: "a" })).map((entry) => entry.kind)).toEqual(["resume", "status_write"]);
		expect((await log.read({ kind: "pause" })).map((entry) => entry.issueId)).toEqual(["b"]);
		expect(await log.read({ limit: 1 })).toHaveLength(1);
	});

	it("keeps every line whole when many writers append while the file rotates", async () => {
		const log = createMulticaActionLog(dir, { maxBytes: 700, maxFiles: 5 });
		await Promise.all(Array.from({ length: 80 }, (_, index) => log.record({ ...base, identifier: `MUL-${index}`, trigger: "y".repeat(30) })));
		const files = (await readdir(dir)).filter((name) => name.startsWith(MULTICA_ACTION_LOG_FILE));
		expect(files.length).toBeLessThanOrEqual(5);
		let total = 0;
		for (const name of files) {
			const raw = await readFile(path.join(dir, name), "utf8");
			for (const line of raw.split("\n").filter(Boolean)) {
				expect(() => JSON.parse(line)).not.toThrow();
				total += 1;
			}
		}
		expect(total).toBeGreaterThan(10);
		const read = await log.read({ limit: 500 });
		expect(read).toHaveLength(total);
		// Written in order: newest first, contiguous.
		const numbers = read.map((entry) => Number(entry.identifier?.replace("MUL-", "")));
		expect(numbers[0]).toBe(79);
		for (let index = 1; index < numbers.length; index += 1) expect(numbers[index - 1] - numbers[index]).toBe(1);
	});

	it("hands every writer of a state directory the same instance, so rotation and appends are not raced", async () => {
		const first = getMulticaActionLog(dir);
		expect(getMulticaActionLog(dir)).toBe(first);
		expect(getMulticaActionLog(`${dir}/`)).toBe(first);
		const other = await mkdtemp(path.join(os.tmpdir(), "ao-action-log-other-"));
		try {
			expect(getMulticaActionLog(other)).not.toBe(first);
		} finally {
			await rm(other, { recursive: true, force: true });
		}
		await Promise.all(Array.from({ length: 20 }, (_, index) => getMulticaActionLog(dir).record({ ...base, identifier: `MUL-${index}` })));
		expect((await lines()).length).toBe(20);
	});
});
