import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMulticaServer, type MulticaServer } from "../shared/multica";
import {
	MULTICA_CREDENTIALS_FILE,
	createMulticaCredentials,
	normalizeToken,
	profileToken,
	type SecretVault,
} from "./multica-credentials";

// Fake fixtures only: these strings are not credentials of any real server.
const PROFILE_TOKEN = "mul_FIXTUREprofileTOKEN0001";
const PASTED_TOKEN = "mul_FIXTUREpastedTOKEN0002";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "ao-creds-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(dir, { recursive: true, force: true });
});

const local = resolveMulticaServer({ mode: "local", customUrl: "http://localhost:3000", apiUrl: "" }) as MulticaServer;
const other = resolveMulticaServer({ mode: "local", customUrl: "http://other.lan:3000", apiUrl: "" }) as MulticaServer;
const cloud = resolveMulticaServer({ mode: "cloud", customUrl: "", apiUrl: "" }) as MulticaServer;

const vault = (protectedStorage = true): SecretVault => ({
	isProtected: () => protectedStorage,
	encrypt: (plain) => Buffer.from(`enc:${plain.split("").reverse().join("")}`),
	decrypt: (blob) => blob.toString().replace(/^enc:/, "").split("").reverse().join(""),
});

const profileFile = (extra: Record<string, unknown> = {}) => JSON.stringify({ server_url: "http://localhost:8080", token: PROFILE_TOKEN, ...extra });

describe("profile credential (T3') and consent", () => {
	it("does not open the profile file without consent", async () => {
		const readProfileConfig = vi.fn(async () => profileFile());
		const credentials = createMulticaCredentials({ stateDir: dir, vault: vault(), readProfileConfig });
		expect(await credentials.resolve(local, "profile", false)).toEqual({ ok: false, reason: "no_consent" });
		expect(readProfileConfig).not.toHaveBeenCalled();
	});

	it("reads the server's own profile once consent is granted", async () => {
		const readProfileConfig = vi.fn(async () => profileFile());
		const credentials = createMulticaCredentials({ stateDir: dir, vault: vault(), readProfileConfig });
		expect(await credentials.resolve(local, "profile", true)).toEqual({ ok: true, token: PROFILE_TOKEN });
		// The default local server uses the default profile; the others are named by the resolver.
		expect(readProfileConfig).toHaveBeenCalledWith(null);
		await credentials.resolve(cloud, "profile", true);
		expect(readProfileConfig).toHaveBeenLastCalledWith("ao-multica.ai");
		await credentials.resolve(other, "profile", true);
		expect(readProfileConfig).toHaveBeenLastCalledWith(other.cliProfile);
	});

	it("refuses a profile that records a different server", async () => {
		const readProfileConfig = async () => profileFile({ server_url: "https://api.evil.example" });
		const credentials = createMulticaCredentials({ stateDir: dir, vault: vault(), readProfileConfig });
		expect(await credentials.resolve(local, "profile", true)).toEqual({ ok: false, reason: "profile_mismatch" });
	});

	it("accepts the web origin or the API origin recorded in the profile", () => {
		expect(profileToken(profileFile({ server_url: "http://localhost:3000" }), local).ok).toBe(true);
		expect(profileToken(profileFile({ server_url: "http://localhost:8080/" }), local).ok).toBe(true);
		expect(profileToken(profileFile({ server_url: "https://api.multica.ai" }), cloud).ok).toBe(true);
		expect(profileToken(profileFile({ server_url: "https://api.multica.ai.evil.example" }), cloud).ok).toBe(false);
	});

	it("reports a missing, unreadable or token-less profile without leaking its content", async () => {
		const run = async (readProfileConfig: () => Promise<string | null>) =>
			createMulticaCredentials({ stateDir: dir, vault: vault(), readProfileConfig }).resolve(local, "profile", true);
		expect(await run(async () => null)).toEqual({ ok: false, reason: "no_token" });
		expect(await run(async () => "{not json")).toEqual({ ok: false, reason: "no_token" });
		expect(await run(async () => JSON.stringify({ server_url: "http://localhost:8080" }))).toEqual({ ok: false, reason: "no_token" });
		expect(await run(async () => JSON.stringify({ token: "has space" }))).toEqual({ ok: false, reason: "no_token" });
		expect(await run(async () => { throw new Error(`EACCES ${PROFILE_TOKEN}`); })).toEqual({ ok: false, reason: "unavailable" });
	});

	it("keeps the profile token out of memory-resident output, files and the console", async () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
		const credentials = createMulticaCredentials({ stateDir: dir, vault: vault(), readProfileConfig: async () => profileFile() });
		await credentials.resolve(local, "profile", true);
		await credentials.hasPasted(local.key);
		for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(PROFILE_TOKEN);
		await expect(stat(path.join(dir, MULTICA_CREDENTIALS_FILE))).rejects.toThrow();
	});
});

describe("pasted credential (T2)", () => {
	it("stores the token encrypted and finds it again after a restart", async () => {
		const first = createMulticaCredentials({ stateDir: dir, vault: vault(), readProfileConfig: async () => null });
		expect(await first.setPasted(local.key, PASTED_TOKEN)).toBe(true);
		const raw = await readFile(path.join(dir, MULTICA_CREDENTIALS_FILE), "utf8");
		expect(raw).not.toContain(PASTED_TOKEN);
		expect(raw).not.toContain(PASTED_TOKEN.split("").reverse().join(""));
		expect((await stat(path.join(dir, MULTICA_CREDENTIALS_FILE))).mode & 0o777).toBe(0o600);

		const second = createMulticaCredentials({ stateDir: dir, vault: vault(), readProfileConfig: async () => null });
		expect(await second.hasPasted(local.key)).toBe(true);
		expect(await second.resolve(local, "pasted", false)).toEqual({ ok: true, token: PASTED_TOKEN });
		expect(await second.hasPasted(cloud.key)).toBe(false);
	});

	it("keeps a pasted token per server", async () => {
		const credentials = createMulticaCredentials({ stateDir: dir, vault: vault(), readProfileConfig: async () => null });
		await credentials.setPasted(local.key, PASTED_TOKEN);
		await credentials.setPasted(cloud.key, "mul_FIXTUREcloudTOKEN0003");
		expect(await credentials.resolve(local, "pasted", false)).toEqual({ ok: true, token: PASTED_TOKEN });
		expect(await credentials.resolve(cloud, "pasted", false)).toEqual({ ok: true, token: "mul_FIXTUREcloudTOKEN0003" });
		expect(await credentials.resolve(other, "pasted", false)).toEqual({ ok: false, reason: "no_token" });
	});

	it("never writes plaintext when protected storage is missing and keeps the token for this run only", async () => {
		const credentials = createMulticaCredentials({ stateDir: dir, vault: vault(false), readProfileConfig: async () => null });
		expect(credentials.canPersist()).toBe(false);
		await credentials.setPasted(local.key, PASTED_TOKEN);
		expect(await credentials.resolve(local, "pasted", false)).toEqual({ ok: true, token: PASTED_TOKEN });
		await expect(stat(path.join(dir, MULTICA_CREDENTIALS_FILE))).rejects.toThrow();
		const restarted = createMulticaCredentials({ stateDir: dir, vault: vault(false), readProfileConfig: async () => null });
		expect(await restarted.hasPasted(local.key)).toBe(false);
	});

	it("tells whether a token is stored without decrypting it, and decrypts only when it is resolved", async () => {
		const decrypt = vi.fn((blob: Buffer) => blob.toString().replace(/^enc:/, "").split("").reverse().join(""));
		const spyVault: SecretVault = { ...vault(), decrypt };
		const first = createMulticaCredentials({ stateDir: dir, vault: spyVault, readProfileConfig: async () => null });
		await first.setPasted(local.key, PASTED_TOKEN);
		decrypt.mockClear();

		// A fresh instance, as after a restart: asking is not decrypting (decrypting can prompt for the keychain).
		const second = createMulticaCredentials({ stateDir: dir, vault: spyVault, readProfileConfig: async () => null });
		expect(await second.hasPasted(local.key)).toBe(true);
		expect(await second.hasPasted(other.key)).toBe(false);
		expect(decrypt).not.toHaveBeenCalled();

		// Resolving decrypts each time; the plaintext is not kept between connections.
		expect(await second.resolve(local, "pasted", false)).toEqual({ ok: true, token: PASTED_TOKEN });
		expect(await second.resolve(local, "pasted", false)).toEqual({ ok: true, token: PASTED_TOKEN });
		expect(decrypt).toHaveBeenCalledTimes(2);
	});

	it("reports a token it could not store", async () => {
		const credentials = createMulticaCredentials({
			stateDir: path.join(dir, "missing", "not-a-dir-parent"),
			vault: { ...vault(), encrypt: () => { throw new Error("keychain locked"); } },
			readProfileConfig: async () => null,
		});
		expect(await credentials.setPasted(local.key, PASTED_TOKEN)).toBe(false);
		expect(await credentials.hasPasted(local.key)).toBe(false);
	});

	it("clears the token from memory and disk", async () => {
		const credentials = createMulticaCredentials({ stateDir: dir, vault: vault(), readProfileConfig: async () => null });
		await credentials.setPasted(local.key, PASTED_TOKEN);
		await credentials.clearPasted(local.key);
		expect(await credentials.hasPasted(local.key)).toBe(false);
		await expect(stat(path.join(dir, MULTICA_CREDENTIALS_FILE))).rejects.toThrow();
	});

	it("refuses tokens with whitespace, control characters or excessive length", async () => {
		const credentials = createMulticaCredentials({ stateDir: dir, vault: vault(), readProfileConfig: async () => null });
		for (const bad of ["", "   ", "a b", "mul_x\r\nX-Injected: 1", "x".repeat(5000)]) {
			expect(await credentials.setPasted(local.key, bad)).toBe(false);
		}
		expect(await credentials.hasPasted(local.key)).toBe(false);
		expect(normalizeToken("  mul_ok  ")).toBe("mul_ok");
		expect(normalizeToken(5)).toBeNull();
	});

	it("ignores a corrupted credentials file", async () => {
		await writeFile(path.join(dir, MULTICA_CREDENTIALS_FILE), "{not json");
		const credentials = createMulticaCredentials({ stateDir: dir, vault: vault(), readProfileConfig: async () => null });
		expect(await credentials.hasPasted(local.key)).toBe(false);
	});
});

describe("page-only mode (T1)", () => {
	it("holds no token and never reads a file", async () => {
		const readProfileConfig = vi.fn(async () => profileFile());
		const credentials = createMulticaCredentials({ stateDir: dir, vault: vault(), readProfileConfig });
		expect(await credentials.resolve(local, "page", true)).toEqual({ ok: false, reason: "page_only" });
		expect(readProfileConfig).not.toHaveBeenCalled();
	});
});
