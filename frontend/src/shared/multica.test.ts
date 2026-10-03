import { describe, expect, it } from "vitest";
import {
	coerceMulticaSettings,
	DEFAULT_MULTICA_SETTINGS,
	MULTICA_DEFAULT_URL,
	multicaRuntimeConfig,
	parseMulticaDeepLink,
	parseMulticaUrl,
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
		expect(coerceMulticaSettings(undefined)).toEqual(DEFAULT_MULTICA_SETTINGS);
		expect(coerceMulticaSettings("nope")).toEqual(DEFAULT_MULTICA_SETTINGS);
		expect(coerceMulticaSettings({ url: 5 })).toEqual(DEFAULT_MULTICA_SETTINGS);
	});

	it("keeps a cleared URL cleared instead of restoring the default", () => {
		expect(coerceMulticaSettings({ url: "" })).toEqual({ url: "" });
		expect(coerceMulticaSettings({ url: "   " })).toEqual({ url: "" });
	});

	it("normalizes a valid URL and treats an invalid stored one as unset", () => {
		expect(coerceMulticaSettings({ url: "localhost:3000" })).toEqual({ url: "http://localhost:3000/" });
		expect(coerceMulticaSettings({ url: "ftp://example.com" })).toEqual({ url: "" });
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
