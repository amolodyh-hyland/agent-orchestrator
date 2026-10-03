import { describe, expect, it } from "vitest";
import {
	coerceMulticaSettings,
	DEFAULT_MULTICA_SETTINGS,
	isMulticaOrigin,
	MULTICA_DEFAULT_URL,
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

describe("isMulticaOrigin", () => {
	const origin = "http://localhost:3000";

	it("matches only the exact origin", () => {
		expect(isMulticaOrigin("http://localhost:3000/issues/1?x=1", origin)).toBe(true);
		expect(isMulticaOrigin("http://localhost:3001/", origin)).toBe(false);
		expect(isMulticaOrigin("https://localhost:3000/", origin)).toBe(false);
		expect(isMulticaOrigin("http://localhost.evil.test/", origin)).toBe(false);
		expect(isMulticaOrigin("http://localhost:3000@evil.test/", origin)).toBe(false);
	});

	it("rejects strings that are not URLs", () => {
		expect(isMulticaOrigin("not a url", origin)).toBe(false);
		expect(isMulticaOrigin("", origin)).toBe(false);
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
