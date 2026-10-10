import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SecretVault } from "./multica-credentials";

type SafeStorageLike = {
	isEncryptionAvailable: () => boolean;
	getSelectedStorageBackend?: () => string;
	encryptString: (plain: string) => Buffer;
	decryptString: (blob: Buffer) => string;
};

/**
 * The OS-backed store, treated as protected only when it really encrypts: on
 * Linux the `basic_text` and `unknown` backends report availability while using
 * a fixed key, so they count as unprotected (same rule as the cloud sign-in).
 */
export function createSafeStorageVault(safeStorage: SafeStorageLike, platform: NodeJS.Platform): SecretVault {
	return {
		isProtected: () => {
			if (!safeStorage.isEncryptionAvailable()) return false;
			if (platform !== "linux") return true;
			const backend = safeStorage.getSelectedStorageBackend?.();
			return backend !== undefined && backend !== "basic_text" && backend !== "unknown";
		},
		encrypt: (plain) => safeStorage.encryptString(plain),
		decrypt: (blob) => safeStorage.decryptString(blob),
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
