import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectTargets, verifyRecoveryReceipt } from "./multica-local-server-preflight";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function recovery() {
	const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "multica-recovery-")));
	dirs.push(dir);
	await chmod(dir, 0o700);
	const receipt: Record<string, unknown> = { version: 1, snapshotDigest: "snapshot", configurationPreserved: true, imageIdentitiesPreserved: true, dataBackupComplete: true, restoreVerified: true };
	for (const key of ["configurationArchive", "imageArchive", "dataBackup", "restoreProcedure", "restoreVerification"]) {
		const content = Buffer.from(`preserved ${key}`);
		const file = path.join(dir, key);
		await writeFile(file, content, { mode: 0o600 });
		receipt[key] = { path: file, sha256: createHash("sha256").update(content).digest("hex") };
	}
	const file = path.join(dir, "receipt.json");
	const save = () => writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
	await save();
	return { dir, receipt, file, save };
}

describe("protected restore evidence", () => {
	it("accepts complete private recovery artifacts for the exact snapshot", async () => {
		const fixture = await recovery();
		await expect(verifyRecoveryReceipt(fixture.file, "snapshot")).resolves.toBeUndefined();
		await expect(verifyRecoveryReceipt(fixture.file, "other engine snapshot")).rejects.toThrow();
	});
	it.each(["configurationPreserved", "imageIdentitiesPreserved", "dataBackupComplete", "restoreVerified", "restoreProcedure", "restoreVerification", "dataBackup", "imageArchive"])("requires %s evidence", async (key) => {
		const fixture = await recovery();
		delete fixture.receipt[key];
		await fixture.save();
		await expect(verifyRecoveryReceipt(fixture.file, "snapshot")).rejects.toThrow();
	});
	it("rejects changed backups, shared receipts and symlink artifacts", async () => {
		const fixture = await recovery();
		const backup = path.join(fixture.dir, "dataBackup");
		await writeFile(backup, "changed");
		await expect(verifyRecoveryReceipt(fixture.file, "snapshot")).rejects.toThrow();
		await chmod(fixture.file, 0o644);
		await expect(verifyRecoveryReceipt(fixture.file, "snapshot")).rejects.toThrow();
		await chmod(fixture.file, 0o600);
		await rm(backup);
		await symlink(path.join(fixture.dir, "imageArchive"), backup);
		await expect(verifyRecoveryReceipt(fixture.file, "snapshot")).rejects.toThrow();
	});
	it("rejects a writable ancestor even with private files", async () => {
		const fixture = await recovery();
		const shared = path.join(fixture.dir, "shared");
		await mkdir(shared);
		const file = path.join(shared, "receipt.json");
		await writeFile(file, JSON.stringify(fixture.receipt), { mode: 0o600 });
		await chmod(shared, 0o777);
		await expect(verifyRecoveryReceipt(file, "snapshot")).rejects.toThrow();
	});
});


describe("resolved target names", () => {
	it("includes every declared service and volume plus the implicit default network", () => {
		expect(resolveProjectTargets("name: multica\nservices:\n  backend: {image: b}\n  custom: {image: c}\nvolumes:\n  pgdata:\n  custom-data:\n")).toEqual({ services: ["backend", "custom"], volumes: ["multica_custom-data", "multica_pgdata"], networks: ["multica_default"] });
	});
});
