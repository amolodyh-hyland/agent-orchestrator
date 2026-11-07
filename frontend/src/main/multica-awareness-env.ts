import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SecretVault } from "./multica-credentials";
import { credentialAccess } from "./desktop-startup";
import { protectedStorageBackend, requireProtectedCiphertext } from "./safe-storage-policy";

type SafeStorageLike = {
	isAsyncEncryptionAvailable: () => Promise<boolean>;
	getSelectedStorageBackend?: () => string;
	encryptStringAsync: (plain: string) => Promise<Buffer>;
	decryptStringAsync: (blob: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>;
};

/**
 * The OS-backed store, treated as protected only when it really encrypts: on
 * Linux the `basic_text` and `unknown` backends report availability while using
 * a fixed key, so they count as unprotected (same rule as the cloud sign-in).
 */
export function createSafeStorageVault(safeStorage: SafeStorageLike, platform: NodeJS.Platform): SecretVault {
	return {
		isProtected: async () => {
			if (!(await credentialAccess("multica-capability", () => safeStorage.isAsyncEncryptionAvailable()))) return false;
			return protectedStorageBackend(platform, platform === "linux" ? safeStorage.getSelectedStorageBackend?.() : undefined);
		},
		encrypt: (plain) => credentialAccess("multica-encrypt", async () => requireProtectedCiphertext(await safeStorage.encryptStringAsync(plain), platform)),
		decrypt: (blob) => credentialAccess("multica-decrypt", () => safeStorage.decryptStringAsync(blob)),
	};
}

/** `<home>/.multica/config.json` for the default profile, `<home>/.multica/profiles/<name>/config.json` otherwise. */
export function multicaProfileConfigPath(home: string, profile: string | null): string {
	const root = path.join(home, ".multica");
	if (profile === null) return path.join(root, "config.json");
	if (!/^[A-Za-z0-9._-]{1,80}$/.test(profile) || profile === "." || profile === "..") throw new Error("invalid profile name");
	return path.join(root, "profiles", profile, "config.json");
}

/** Reads a profile's config text, or null when the file does not exist. Called only after the user consented for that server. */
export function createProfileConfigReader(home: () => string): (profile: string | null) => Promise<string | null> {
	return async (profile) => {
		try {
			return await readFile(multicaProfileConfigPath(home(), profile), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	};
}
