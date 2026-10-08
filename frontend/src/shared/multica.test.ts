import { describe, expect, it } from "vitest";
import {
	coerceMulticaSettings,
	DEFAULT_MULTICA_SETTINGS,
	MULTICA_CLOUD_PARTITION,
	MULTICA_DEFAULT_URL,
	MULTICA_PARTITION,
	multicaCliSignInCommand,
	multicaPartitionFor,
	multicaRuntimeConfig,
	multicaWebSocketHeaders,
	parseMulticaDeepLink,
	parseMulticaUrl,
	resolveMulticaServer,
	validateMulticaServerUrl,
} from "./multica";

describe("parseMulticaUrl", () => {
	it("defaults to the local web app port from the Multica self-hosting docs", () => {
		expect(MULTICA_DEFAULT_URL).toBe("http://localhost:3000");
		expect(parseMulticaUrl(MULTICA_DEFAULT_URL)).toEqual({
			ok: true,
			url: "http://localhost:3000/",
			origin: "http://localhost:3000",
		});
	});

	it("accepts http and https URLs, keeping the path and dropping the fragment", () => {
		expect(parseMulticaUrl(" https://multica.example.com/app#section ")).toEqual({
			ok: true,
			url: "https://multica.example.com/app",
			origin: "https://multica.example.com",
		});
	});

	it("treats a bare host:port as http", () => {
		expect(parseMulticaUrl("localhost:3000")).toEqual({
			ok: true,
			url: "http://localhost:3000/",
			origin: "http://localhost:3000",
		});
	});

	it.each([
		["empty", ""],
		["blank", "   "],
		["a non-http scheme", "ftp://example.com"],
		["a file URL", "file:///etc/passwd"],
		["a script URL", "javascript:alert(1)"],
		["a data URL", "data:text/html,hi"],
		["embedded credentials", "http://user:secret@localhost:3000"],
		["a missing host", "http://"],
		["a number", 3000],
		["null", null],
	])("rejects %s", (_name, input) => {
		expect(parseMulticaUrl(input)).toEqual({ ok: false });
	});
});

describe("multicaRuntimeConfig", () => {
	it("points a local web app at the API on port 8080 of the same host", () => {
		expect(multicaRuntimeConfig("http://localhost:3000")).toEqual({
			ok: true,
			config: {
				schemaVersion: 1,
				apiUrl: "http://localhost:8080",
				wsUrl: "ws://localhost:8080/ws",
				appUrl: "http://localhost:3000",
			},
		});
		expect(multicaRuntimeConfig("http://192.168.1.5:3000/issues")).toMatchObject({
			ok: true,
			config: { apiUrl: "http://192.168.1.5:8080", appUrl: "http://192.168.1.5:3000" },
		});
	});

	it("uses the api.<host> convention for hosted deployments", () => {
		expect(multicaRuntimeConfig("https://multica.ai")).toEqual({
			ok: true,
			config: {
				schemaVersion: 1,
				apiUrl: "https://api.multica.ai",
				wsUrl: "wss://api.multica.ai/ws",
				appUrl: "https://multica.ai",
			},
		});
	});

	it("reports a blocking error when the URL is unusable", () => {
		expect(multicaRuntimeConfig("")).toEqual({ ok: false, error: { message: "Multica URL is not set" } });
		expect(multicaRuntimeConfig("ftp://example.com")).toMatchObject({ ok: false });
	});
});

describe("coerceMulticaSettings", () => {
	it("falls back to the default when nothing usable was stored", () => {
		expect(DEFAULT_MULTICA_SETTINGS).toEqual({ mode: "local", customUrl: "http://localhost:3000", apiUrl: "" });
		expect(coerceMulticaSettings(undefined)).toEqual(DEFAULT_MULTICA_SETTINGS);
		expect(coerceMulticaSettings("nope")).toEqual(DEFAULT_MULTICA_SETTINGS);
		expect(coerceMulticaSettings({ url: 5 })).toEqual(DEFAULT_MULTICA_SETTINGS);
		expect(coerceMulticaSettings({ version: 2 })).toEqual(DEFAULT_MULTICA_SETTINGS);
	});

	it("migrates a version 1 file: cleared stays cleared, Multica Cloud's web app becomes cloud, anything else stays local", () => {
		expect(coerceMulticaSettings({ url: "" })).toEqual({ mode: "local", customUrl: "", apiUrl: "" });
		expect(coerceMulticaSettings({ url: "   " })).toEqual({ mode: "local", customUrl: "", apiUrl: "" });
		expect(coerceMulticaSettings({ url: "localhost:3000" })).toEqual({ mode: "local", customUrl: "http://localhost:3000", apiUrl: "" });
		expect(coerceMulticaSettings({ url: "https://multica.ai/" })).toEqual({ mode: "cloud", customUrl: "http://localhost:3000", apiUrl: "" });
		expect(coerceMulticaSettings({ url: "https://multica.example.com/app" })).toMatchObject({ mode: "local", customUrl: "https://multica.example.com" });
		expect(coerceMulticaSettings({ url: "ftp://example.com" })).toEqual({ mode: "local", customUrl: "", apiUrl: "" });
	});

	it("reads a version 2 file, reducing paths to origins and dropping unusable URLs", () => {
		expect(
			coerceMulticaSettings({ version: 2, mode: "cloud", customUrl: "https://multica.example.com/x", apiUrl: "https://api.example.com/" }),
		).toEqual({ mode: "cloud", customUrl: "https://multica.example.com", apiUrl: "https://api.example.com" });
		expect(coerceMulticaSettings({ mode: "local", customUrl: "javascript:alert(1)", apiUrl: "ftp://x" })).toEqual({
			mode: "local",
			customUrl: "",
			apiUrl: "",
		});
		expect(coerceMulticaSettings({ mode: "local" })).toEqual(DEFAULT_MULTICA_SETTINGS);
		expect(coerceMulticaSettings({ mode: "elsewhere", url: "" })).toEqual({ mode: "local", customUrl: "", apiUrl: "" });
	});
});

describe("validateMulticaServerUrl", () => {
	it.each([
		["http://localhost:3000", "http://localhost:3000"],
		["localhost:3000", "http://localhost:3000"],
		["http://127.0.0.1:3000/", "http://127.0.0.1:3000"],
		["http://10.1.2.3:3000", "http://10.1.2.3:3000"],
		["http://172.20.0.5", "http://172.20.0.5"],
		["http://192.168.1.50:3000", "http://192.168.1.50:3000"],
		["http://169.254.1.1", "http://169.254.1.1"],
		["http://100.101.102.103:3000", "http://100.101.102.103:3000"],
		["http://[::1]:3000", "http://[::1]:3000"],
		["http://[fd12:3456::1]:3000", "http://[fd12:3456::1]:3000"],
		["http://multica:3000", "http://multica:3000"],
		["http://box.local:3000", "http://box.local:3000"],
		["http://multica.lan", "http://multica.lan"],
		["http://multica.internal", "http://multica.internal"],
		["https://multica.example.com", "https://multica.example.com"],
		[" https://multica.example.com:8443/ ", "https://multica.example.com:8443"],
	])("accepts %s", (input, origin) => {
		expect(validateMulticaServerUrl(input)).toEqual({ ok: true, origin });
	});

	it.each([
		["http://multica.example.com", "insecure_http"],
		["http://8.8.8.8:3000", "insecure_http"],
		["http://172.32.0.1", "insecure_http"],
		["http://192.169.1.1", "insecure_http"],
		["http://100.128.0.1", "insecure_http"],
		["http://[2001:db8::1]", "insecure_http"],
		["https://multica.example.com/app", "path_not_allowed"],
		["https://multica.example.com/?x=1", "path_not_allowed"],
		["ftp://example.com", "invalid_url"],
		["http://user:pass@localhost:3000", "invalid_url"],
		["", "invalid_url"],
		[42, "invalid_url"],
	])("rejects %s as %s", (input, error) => {
		expect(validateMulticaServerUrl(input)).toEqual({ ok: false, error });
	});
});

describe("resolveMulticaServer", () => {
	const cloud = { mode: "cloud", customUrl: "", apiUrl: "" } as const;

	it("selects Multica Cloud with the same config Multica Desktop ships as its default", () => {
		expect(resolveMulticaServer(cloud)).toEqual({
			key: "cloud",
			mode: "cloud",
			appUrl: "https://multica.ai",
			config: { schemaVersion: 1, apiUrl: "https://api.multica.ai", wsUrl: "wss://api.multica.ai/ws", appUrl: "https://multica.ai" },
			partition: MULTICA_CLOUD_PARTITION,
			cliProfile: "ao-multica.ai",
		});
		expect(resolveMulticaServer({ ...cloud, customUrl: "https://elsewhere.example.com" })?.key).toBe("cloud");
	});

	it("selects the default local server on the original partition and the default CLI profile", () => {
		expect(resolveMulticaServer(DEFAULT_MULTICA_SETTINGS)).toEqual({
			key: "http://localhost:3000",
			mode: "local",
			appUrl: "http://localhost:3000",
			config: { schemaVersion: 1, apiUrl: "http://localhost:8080", wsUrl: "ws://localhost:8080/ws", appUrl: "http://localhost:3000" },
			partition: MULTICA_PARTITION,
			cliProfile: null,
		});
	});

	it("derives a custom server's API from the host, or takes the explicit API origin", () => {
		expect(resolveMulticaServer({ mode: "local", customUrl: "https://multica.example.com", apiUrl: "" })?.config).toMatchObject({
			apiUrl: "https://api.multica.example.com",
			wsUrl: "wss://api.multica.example.com/ws",
		});
		const sameOrigin = resolveMulticaServer({ mode: "local", customUrl: "https://multica.example.com", apiUrl: "https://multica.example.com" });
		expect(sameOrigin?.config).toEqual({
			schemaVersion: 1,
			apiUrl: "https://multica.example.com",
			wsUrl: "wss://multica.example.com/ws",
			appUrl: "https://multica.example.com",
		});
		expect(sameOrigin?.cliProfile).toBe("ao-multica.example.com--multica.example.com");
		expect(resolveMulticaServer({ mode: "local", customUrl: "http://192.168.1.5:3000", apiUrl: "" })?.cliProfile).toBe("ao-192.168.1.5-3000");
	});

	it("never shares a partition, key or CLI profile between two API addresses of the same web address", () => {
		const web = "https://multica.example.com";
		const derived = resolveMulticaServer({ mode: "local", customUrl: web, apiUrl: "" })!;
		const a = resolveMulticaServer({ mode: "local", customUrl: web, apiUrl: "https://api-a.example.com" })!;
		const b = resolveMulticaServer({ mode: "local", customUrl: web, apiUrl: "https://api-b.example.com" })!;
		expect(new Set([derived.partition, a.partition, b.partition]).size).toBe(3);
		expect(new Set([derived.key, a.key, b.key]).size).toBe(3);
		expect(new Set([derived.cliProfile, a.cliProfile, b.cliProfile]).size).toBe(3);

		const local = resolveMulticaServer(DEFAULT_MULTICA_SETTINGS)!;
		const rerouted = resolveMulticaServer({ mode: "local", customUrl: "http://localhost:3000", apiUrl: "https://attacker.example" })!;
		expect(rerouted.partition).not.toBe(local.partition);
		expect(rerouted.partition).not.toBe(MULTICA_PARTITION);
		expect(rerouted.key).not.toBe(local.key);
		expect(rerouted.cliProfile).not.toBeNull();
	});

	it("keeps the same identity when the explicit API address equals the derived one", () => {
		const base = resolveMulticaServer({ mode: "local", customUrl: "http://localhost:3000", apiUrl: "" })!;
		const explicit = resolveMulticaServer({ mode: "local", customUrl: "http://localhost:3000", apiUrl: "http://localhost:8080" })!;
		expect(explicit.key).toBe(base.key);
		expect(explicit.partition).toBe(MULTICA_PARTITION);
		expect(explicit.cliProfile).toBeNull();
	});

	it("is off without a custom URL", () => {
		expect(resolveMulticaServer({ mode: "local", customUrl: "", apiUrl: "" })).toBeNull();
	});

	it("keeps servers on separate partitions: default, cloud and every other origin differ and are stable", () => {
		const a = multicaPartitionFor("local", "https://a.example.com");
		const b = multicaPartitionFor("local", "https://b.example.com");
		expect(a).toMatch(/^persist:ao-multica-[0-9a-f]{16}$/);
		expect(new Set([a, b, MULTICA_PARTITION, MULTICA_CLOUD_PARTITION]).size).toBe(4);
		expect(multicaPartitionFor("local", "https://a.example.com")).toBe(a);
		expect(multicaPartitionFor("local", "http://localhost:3000")).toBe(MULTICA_PARTITION);
		expect(multicaPartitionFor("cloud", "https://multica.ai")).toBe(MULTICA_CLOUD_PARTITION);
		expect(multicaPartitionFor("local", "https://multica.ai")).not.toBe(MULTICA_CLOUD_PARTITION);
	});

	it("names the sign-in command of a non-default CLI profile and none for the default one", () => {
		expect(multicaCliSignInCommand(resolveMulticaServer(DEFAULT_MULTICA_SETTINGS)!)).toBeNull();
		expect(multicaCliSignInCommand(resolveMulticaServer(cloud)!)).toBe("multica login --profile ao-multica.ai");
		expect(multicaCliSignInCommand(resolveMulticaServer({ mode: "local", customUrl: "https://multica.example.com", apiUrl: "" })!)).toBe(
			"multica setup self-host --profile ao-multica.example.com --server-url https://api.multica.example.com --app-url https://multica.example.com",
		);
	});
});

describe("parseMulticaDeepLink", () => {
	it("extracts the sign-in token and the invitation id", () => {
		expect(parseMulticaDeepLink("multica://auth/callback?token=abc.def")).toEqual({ channel: "auth:token", payload: "abc.def" });
		expect(parseMulticaDeepLink("multica://invite/9f1c-2")).toEqual({ channel: "invite:open", payload: "9f1c-2" });
	});

	it("ignores other schemes, hosts, paths and empty or oversized values", () => {
		for (const input of [
			"https://auth/callback?token=abc",
			"ao-app://auth/callback?token=abc",
			"multica://auth/callback",
			"multica://auth/callback?token=",
			"multica://auth/elsewhere?token=abc",
			"multica://invite/",
			`multica://auth/callback?token=${"a".repeat(9000)}`,
			"not a url",
		]) {
			expect(parseMulticaDeepLink(input)).toBeNull();
		}
	});
});

describe("multicaWebSocketHeaders", () => {
	const CONFIG = { schemaVersion: 1, apiUrl: "http://localhost:8080", wsUrl: "ws://localhost:8080/ws", appUrl: "http://localhost:3000" } as const;
	const CLOUD = { schemaVersion: 1, apiUrl: "https://api.multica.ai", wsUrl: "wss://api.multica.ai/ws", appUrl: "https://multica.ai" } as const;

	it("presents the app origin for a handshake to the configured API", () => {
		expect(multicaWebSocketHeaders("ws://localhost:8080/ws?workspace_slug=x", { Origin: "null", Cookie: "a=b" }, CONFIG)).toEqual({
			Origin: CONFIG.appUrl,
			Cookie: "a=b",
		});
		expect(multicaWebSocketHeaders("ws://localhost:8080/ws", { Origin: "file://" }, CONFIG)).toEqual({ Origin: CONFIG.appUrl });
		expect(multicaWebSocketHeaders("wss://api.multica.ai/ws", { origin: "null" }, CLOUD)).toEqual({ origin: "https://multica.ai" });
	});

	it("leaves other requests alone", () => {
		const headers = { Origin: "null" };
		expect(multicaWebSocketHeaders("ws://evil.example.com/ws", headers, CONFIG)).toBe(headers);
		expect(multicaWebSocketHeaders("http://localhost:8080/api/me", headers, CONFIG)).toBe(headers);
		expect(multicaWebSocketHeaders("ws://localhost:8080/ws", headers, null)).toBe(headers);
		expect(multicaWebSocketHeaders("wss://api.multica.ai/ws", headers, CONFIG)).toBe(headers);
		const real = { Origin: "http://other.example" };
		expect(multicaWebSocketHeaders("ws://localhost:8080/ws", real, CONFIG)).toBe(real);
	});
});
