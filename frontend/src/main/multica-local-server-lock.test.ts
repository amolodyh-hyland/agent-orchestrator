import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLocalServerProjectLock, PROJECT_LOCK_NAME } from "./multica-local-server-lock";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function root() {
	const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "multica-control-lock-")));
	dirs.push(dir);
	await chmod(dir, 0o700);
	return dir;
}

describe("host project lock", () => {
	it("excludes a separate process until released", async () => {
		const dir = await root();
		const held = await acquireLocalServerProjectLock(dir);
		expect(held).not.toBeNull();
		const helper = path.join(process.cwd(), "src/main/multica-local-server-lock.ts");
		const script = 'const {acquireLocalServerProjectLock} = await import(process.argv[1]); const lock = await acquireLocalServerProjectLock(process.argv[2]); process.stdout.write(lock ? "acquired" : "busy"); if (lock) await lock.release();';
		const other = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, helper, dir], { env: {}, timeout: 15_000 });
		expect((await other()).stdout).toBe("busy");
		await held!.release();
		expect((await other()).stdout).toBe("acquired");
	});
	it("does not reclaim a retained crash lock by PID or age", async () => {
		const dir = await root();
		await mkdir(path.join(dir, PROJECT_LOCK_NAME));
		await writeFile(path.join(dir, PROJECT_LOCK_NAME, "owner.json"), JSON.stringify({ pid: 99999999, nonce: "abandoned" }));
		expect(await acquireLocalServerProjectLock(dir)).toBeNull();
	});
	it("refuses an unsafe state directory", async () => {
		const dir = await root();
		await chmod(dir, 0o777);
		await expect(acquireLocalServerProjectLock(dir)).rejects.toThrow("Unsafe");
	});
});
