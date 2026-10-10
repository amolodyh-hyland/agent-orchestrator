import { mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MULTICA_CLOUD_APP_URL } from "../shared/multica";
import {
	DEFAULT_WATCH_CONFIG,
	MAX_WATCHED_SERVERS,
	MULTICA_WATCH_FILE,
	coerceWatchConfig,
	createMulticaWatchConfigStore,
	type WatchConfig,
} from "./multica-watch-config";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "ao-watch-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const server = (overrides: Record<string, unknown> = {}) => ({
	serverKey: "ignored",
	mode: "local",
	customUrl: "http://localhost:3000",
	apiUrl: "",
	enabled: true,
	credentialSource: "pasted",
	consentGranted: false,
	workspaces: [{ workspaceId: "w1", slug: "acme", name: "Acme", watch: true }],
	...overrides,
});

describe("coerceWatchConfig", () => {
	it("is entirely off by default", () => {
		for (const raw of [undefined, null, "x", [], {}, { version: 2 }]) {
			expect(coerceWatchConfig(raw)).toEqual(DEFAULT_WATCH_CONFIG);
		}
		expect(DEFAULT_WATCH_CONFIG).toEqual({ masterEnabled: false, maxSockets: 8, servers: [] });
	});

	it("treats a server or a workspace as off unless the file says true", () => {
		const config = coerceWatchConfig({
			version: 1,
			servers: [server({ enabled: undefined, workspaces: [{ workspaceId: "w1", slug: "acme" }] })],
		});
		expect(config.masterEnabled).toBe(false);
		expect(config.servers[0].enabled).toBe(false);
		expect(config.servers[0].consentGranted).toBe(false);
		expect(config.servers[0].workspaces[0].watch).toBe(false);
	});

	it("recomputes the server key instead of trusting the file", () => {
		const config = coerceWatchConfig({ version: 1, servers: [server({ serverKey: "cloud" }), server({ mode: "cloud", customUrl: "" })] });
		expect(config.servers.map((entry) => entry.serverKey)).toEqual(["http://localhost:3000", "cloud"]);
		expect(MULTICA_CLOUD_APP_URL).toBe("https://multica.ai");
	});

	it("drops invalid servers, duplicates and workspaces, and clamps the socket setting", () => {
		const config = coerceWatchConfig({
			version: 1,
			maxSockets: 99,
			servers: [
				server(),
				server(),
				server({ mode: "weird" }),
				server({ customUrl: "ftp://nope" }),
				server({ customUrl: "http://other:3000", workspaces: [{ workspaceId: "w1", slug: "a" }, { workspaceId: "w1", slug: "b" }, { slug: "x" }, null] }),
			],
		});
		expect(config.servers).toHaveLength(2);
		expect(config.servers[1].workspaces).toHaveLength(1);
		expect(config.maxSockets).toBe(8);
		expect(coerceWatchConfig({ version: 1, maxSockets: 0 }).maxSockets).toBe(1);
		expect(coerceWatchConfig({ version: 1, maxSockets: 3 }).maxSockets).toBe(3);
	});

	it("applies the add-time URL rules: no plain http to a public host, no path", () => {
		const keep = (overrides: Record<string, unknown>) => coerceWatchConfig({ version: 1, servers: [server(overrides)] }).servers.length;
		expect(keep({ customUrl: "http://localhost:3000" })).toBe(1);
		expect(keep({ customUrl: "http://192.168.1.20:3000" })).toBe(1);
		expect(keep({ customUrl: "https://multica.example.com" })).toBe(1);
		expect(keep({ customUrl: "http://multica.example.com" })).toBe(0);
		expect(keep({ customUrl: "http://localhost:3000", apiUrl: "http://api.example.com" })).toBe(0);
		expect(keep({ customUrl: "https://multica.example.com/app" })).toBe(0);
		expect(keep({ customUrl: "http://169.254.169.254" })).toBe(0);
		// Cloud ignores the address fields.
		expect(keep({ mode: "cloud", customUrl: "http://public.example.com" })).toBe(1);
	});

	it("caps the number of servers", () => {
		const servers = Array.from({ length: MAX_WATCHED_SERVERS + 4 }, (_, index) => server({ customUrl: `http://host${index}:3000` }));
		expect(coerceWatchConfig({ version: 1, servers }).servers).toHaveLength(MAX_WATCHED_SERVERS);
	});

	it("falls back to the profile source for an unknown credential source", () => {
		expect(coerceWatchConfig({ version: 1, servers: [server({ credentialSource: "env" })] }).servers[0].credentialSource).toBe("profile");
	});
});

describe("watch config store", () => {
	it("persists with mode 0600 through an atomic write and reads back", async () => {
		const store = createMulticaWatchConfigStore(dir);
		expect(await store.read()).toEqual(DEFAULT_WATCH_CONFIG);
		const next = await store.update((current: WatchConfig) => ({ ...current, masterEnabled: true, servers: coerceWatchConfig({ version: 1, servers: [server()] }).servers }));
		expect(next.masterEnabled).toBe(true);
		expect((await stat(path.join(dir, MULTICA_WATCH_FILE))).mode & 0o777).toBe(0o600);
		expect(await createMulticaWatchConfigStore(dir).read()).toEqual(next);
		expect((await readdir(dir)).filter((name) => name.startsWith(".multica-watch-"))).toEqual([]);
	});

	it("never writes a token field even if one is passed through", async () => {
		const store = createMulticaWatchConfigStore(dir);
		await store.update((current) => ({ ...current, servers: coerceWatchConfig({ version: 1, servers: [server({ token: "mul_secretsecret1234" })] }).servers }));
		expect(await readFile(path.join(dir, MULTICA_WATCH_FILE), "utf8")).not.toContain("mul_secret");
	});

	it("serialises concurrent updates", async () => {
		const store = createMulticaWatchConfigStore(dir);
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				store.update((current) => ({ ...current, maxSockets: Math.min(8, current.maxSockets === 8 ? 1 : current.maxSockets + 1), masterEnabled: index % 2 === 0 })),
			),
		);
		const final = await store.read();
		expect(final.maxSockets).toBe(8);
	});

	it("reads defaults from a corrupt file", async () => {
		await writeFile(path.join(dir, MULTICA_WATCH_FILE), "{not json");
		expect(await createMulticaWatchConfigStore(dir).read()).toEqual(DEFAULT_WATCH_CONFIG);
	});
});
