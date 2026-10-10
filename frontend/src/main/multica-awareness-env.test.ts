import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProfileConfigReader, createSafeStorageVault, multicaProfileConfigPath } from "./multica-awareness-env";

const storage = (available: boolean, backend?: string) => ({
	isEncryptionAvailable: () => available,
	getSelectedStorageBackend: backend === undefined ? undefined : () => backend,
	encryptString: (plain: string) => Buffer.from(plain),
	decryptString: (blob: Buffer) => blob.toString(),
});

describe("safeStorage vault", () => {
	it("is protected only when encryption is available and, on Linux, not a plain-text backend", () => {
		expect(createSafeStorageVault(storage(true), "darwin").isProtected()).toBe(true);
		expect(createSafeStorageVault(storage(false), "darwin").isProtected()).toBe(false);
		expect(createSafeStorageVault(storage(true, "gnome_libsecret"), "linux").isProtected()).toBe(true);
		expect(createSafeStorageVault(storage(true, "basic_text"), "linux").isProtected()).toBe(false);
		expect(createSafeStorageVault(storage(true, "unknown"), "linux").isProtected()).toBe(false);
		expect(createSafeStorageVault(storage(true), "linux").isProtected()).toBe(false);
	});
});

describe("profile config path and reader", () => {
	it("maps the default and named profiles and refuses path tricks", () => {
		expect(multicaProfileConfigPath("/h", null)).toBe("/h/.multica/config.json");
		expect(multicaProfileConfigPath("/h", "ao-multica.ai")).toBe("/h/.multica/profiles/ao-multica.ai/config.json");
		for (const bad of ["..", ".", "../x", "a/b", "", "a b"]) expect(() => multicaProfileConfigPath("/h", bad)).toThrow();
	});

	it("reads a fixture profile under a temporary home and reports a missing one as null", async () => {
		const home = await mkdtemp(path.join(os.tmpdir(), "ao-home-"));
		try {
			await mkdir(path.join(home, ".multica", "profiles", "p"), { recursive: true });
			await writeFile(path.join(home, ".multica", "profiles", "p", "config.json"), '{"token":"fixture"}');
			const read = createProfileConfigReader(() => home);
			expect(await read("p")).toBe('{"token":"fixture"}');
			expect(await read(null)).toBeNull();
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
