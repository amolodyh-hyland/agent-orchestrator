import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type LocalServerProjectLock = { release: () => Promise<void> };
export const PROJECT_LOCK_NAME = "multica-project.lock";

export async function acquireLocalServerProjectLock(root: string): Promise<LocalServerProjectLock | null> {
	if (!path.isAbsolute(root)) throw new Error("Lock root must be absolute");
	await mkdir(root, { recursive: true, mode: 0o700 });
	if (await realpath(root) !== root) throw new Error("Lock root must be canonical");
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	for (let dir = root; ; dir = path.dirname(dir)) {
		const stat = await lstat(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && (stat.uid !== uid && stat.uid !== 0 || (stat.mode & (dir === root ? 0o077 : 0o022)) !== 0))) throw new Error("Unsafe project lock directory");
		if (path.dirname(dir) === dir) break;
	}
	const lock = path.join(root, PROJECT_LOCK_NAME);
	try {
		await mkdir(lock, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
		throw error;
	}
	const identity = await lstat(lock);
	const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
	const file = path.join(lock, "owner.json");
	// Never reclaim a lock on PID age or timeout: another operation may still be running.
	await writeFile(file, owner, { flag: "wx", mode: 0o600 });
	let released = false;
	return { release: async () => {
		if (released) return;
		const current = await lstat(lock);
		if (current.dev !== identity.dev || current.ino !== identity.ino || await readFile(file, "utf8") !== owner) throw new Error("Project lock identity changed; recovery required");
		await unlink(file);
		await rmdir(lock);
		released = true;
	} };
}
