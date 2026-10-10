import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MulticaCredentialSource } from "../shared/multica-awareness";
import type { MulticaServer } from "../shared/multica";

// Credentials for the awareness layer, one per server (`serverKey`).
//
// - profile: the token of the server's Multica CLI profile, read at use time
//   and only after the user consented for that server. Kept in memory only.
// - pasted: a personal token the user pasted once, encrypted with the OS
//   keychain-backed store when it is protected (decrypted only when a
//   connection resolves it, and never cached), otherwise held in memory for this
//   run only, because that is then its only home. Never written as plaintext.
// - page: no token. The page's own sign-in is used through the view host.
//
// A token lives only in the main process. It is never returned from an IPC
// handler, written to a settings file, the action log or the environment of a
// child, and no function in this module logs.

export const MULTICA_CREDENTIALS_FILE = "multica-credentials.json";
export const MAX_TOKEN_LENGTH = 4096;

/** The OS-backed secret store. `isProtected` is false when encryption is missing or only obfuscates (Linux `basic_text`). */
export type SecretVault = {
	isProtected: () => boolean;
	encrypt: (plain: string) => Buffer;
	decrypt: (blob: Buffer) => string;
};

export type CredentialFailure =
	| "no_consent"
	| "no_token"
	| "profile_mismatch"
	| "page_only"
	| "unavailable";

export type CredentialResult = { ok: true; token: string } | { ok: false; reason: CredentialFailure };

export type MulticaCredentialsOptions = {
	stateDir: string;
	vault: SecretVault;
	/** Reads a profile's `config.json` text, or null when the file is missing. Injected so tests never touch a real home directory. */
	readProfileConfig: (profile: string | null) => Promise<string | null>;
};

export type MulticaCredentials = {
	/**
	 * The token for `server` under `source`. A profile token is read only when
	 * `consentGranted` is true; without it the profile file is not opened.
	 */
	resolve: (server: MulticaServer, source: MulticaCredentialSource, consentGranted: boolean) => Promise<CredentialResult>;
	/** Stores a pasted token for the server. Returns false when the token is not usable. */
	setPasted: (serverKey: string, token: string) => Promise<boolean>;
	clearPasted: (serverKey: string) => Promise<void>;
	hasPasted: (serverKey: string) => Promise<boolean>;
	/** True when a pasted token survives a restart. */
	canPersist: () => boolean;
};

/** Refuses empty values, whitespace and control characters (header injection) and oversize input. */
export function normalizeToken(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const token = raw.trim();
	if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
	return /[\s\u0000-\u001F\u007F]/.test(token) ? null : token;
}

function originOf(value: string): string | null {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

/**
 * The profile token, but only when its recorded server matches this server.
 * A profile that names another origin is refused so a token never reaches a
 * server it was not issued for.
 */
export function profileToken(contents: string, server: Pick<MulticaServer, "appUrl" | "config">): CredentialResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		return { ok: false, reason: "no_token" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "no_token" };
	const record = parsed as Record<string, unknown>;
	const token = normalizeToken(record.token);
	if (token === null) return { ok: false, reason: "no_token" };
	if (typeof record.server_url === "string" && record.server_url.trim() !== "") {
		const recorded = originOf(record.server_url.trim());
		const allowed = [server.config.apiUrl, server.appUrl].map(originOf);
		if (recorded === null || !allowed.includes(recorded)) return { ok: false, reason: "profile_mismatch" };
	}
	return { ok: true, token };
}

type StoredFile = { version: 1; tokens: Record<string, string> };

export function createMulticaCredentials(options: MulticaCredentialsOptions): MulticaCredentials {
	const file = path.join(options.stateDir, MULTICA_CREDENTIALS_FILE);
	// Pasted tokens when protected storage is missing. Never a cache of decrypted ones.
	const memory = new Map<string, string>();
	let queue: Promise<void> = Promise.resolve();
	const run = <T>(operation: () => Promise<T>): Promise<T> => {
		const queued = queue.then(operation, operation);
		queue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	};

	async function readStored(): Promise<StoredFile> {
		try {
			const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
			if (parsed && typeof parsed === "object" && (parsed as StoredFile).version === 1 && typeof (parsed as StoredFile).tokens === "object") {
				return { version: 1, tokens: { ...(parsed as StoredFile).tokens } };
			}
		} catch {
			// A missing or unreadable file holds no tokens.
		}
		return { version: 1, tokens: {} };
	}

	async function writeStored(stored: StoredFile): Promise<void> {
		if (Object.keys(stored.tokens).length === 0) {
			await rm(file, { force: true });
			return;
		}
		await mkdir(options.stateDir, { recursive: true, mode: 0o750 });
		const temporary = path.join(options.stateDir, `.multica-credentials-${process.pid}-${randomUUID()}.json`);
		try {
			await writeFile(temporary, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
			await rename(temporary, file);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}

	/** Decrypts on every call, so the plaintext lives only as long as the caller keeps it. */
	async function pastedToken(serverKey: string): Promise<string | null> {
		if (!options.vault.isProtected()) return memory.get(serverKey) ?? null;
		const stored = (await readStored()).tokens[serverKey];
		if (typeof stored !== "string") return null;
		try {
			return normalizeToken(options.vault.decrypt(Buffer.from(stored, "base64")));
		} catch {
			return null;
		}
	}

	/** Whether a token is stored, without decrypting it (decrypting can prompt for the keychain). */
	async function hasStoredToken(serverKey: string): Promise<boolean> {
		if (!options.vault.isProtected()) return memory.has(serverKey);
		return typeof (await readStored()).tokens[serverKey] === "string";
	}

	return {
		resolve: async (server, source, consentGranted) => {
			if (source === "page") return { ok: false, reason: "page_only" };
			if (source === "pasted") {
				const token = await run(() => pastedToken(server.key));
				return token === null ? { ok: false, reason: "no_token" } : { ok: true, token };
			}
			if (!consentGranted) return { ok: false, reason: "no_consent" };
			let contents: string | null;
			try {
				contents = await options.readProfileConfig(server.cliProfile);
			} catch {
				return { ok: false, reason: "unavailable" };
			}
			if (contents === null) return { ok: false, reason: "no_token" };
			return profileToken(contents, server);
		},
		setPasted: (serverKey, rawToken) =>
			run(async () => {
				const token = normalizeToken(rawToken);
				if (token === null || serverKey.length === 0) return false;
				if (!options.vault.isProtected()) {
					memory.set(serverKey, token);
					return true;
				}
				try {
					const stored = await readStored();
					stored.tokens[serverKey] = options.vault.encrypt(token).toString("base64");
					await writeStored(stored);
				} catch {
					// Nothing was stored, so there is no token to use: report it rather than pretend.
					return false;
				}
				return true;
			}),
		clearPasted: (serverKey) =>
			run(async () => {
				memory.delete(serverKey);
				try {
					const stored = await readStored();
					if (serverKey in stored.tokens) {
						delete stored.tokens[serverKey];
						await writeStored(stored);
					}
				} catch {
					// Nothing stored, nothing to clear.
				}
			}),
		hasPasted: (serverKey) => run(() => hasStoredToken(serverKey)),
		canPersist: () => options.vault.isProtected(),
	};
}
