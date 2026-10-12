import { describe, expect, it } from "vitest";
import {
	isLoopbackMulticaHost,
	localServerAvailability,
	parseLocalServerService,
	parseLocalServerTail,
} from "./multica-local-server";

describe("localServerAvailability", () => {
	it("is available for the default local server and for other loopback addresses", () => {
		expect(localServerAvailability({ mode: "local", customUrl: "http://localhost:3000", apiUrl: "" })).toEqual({ available: true, webUrl: "http://localhost:3000", webPort: 3000 });
		expect(localServerAvailability({ mode: "local", customUrl: "http://127.0.0.1:3001", apiUrl: "" })).toMatchObject({ available: true, webPort: 3001 });
		expect(localServerAvailability({ mode: "local", customUrl: "http://[::1]:3000", apiUrl: "" })).toMatchObject({ available: true });
	});

	it("is not available in Cloud mode, even when a local address is remembered", () => {
		expect(localServerAvailability({ mode: "cloud", customUrl: "http://localhost:3000", apiUrl: "" })).toEqual({ available: false, reason: "cloud" });
	});

	it("is not available without an address", () => {
		expect(localServerAvailability({ mode: "local", customUrl: "", apiUrl: "" })).toEqual({ available: false, reason: "no_url" });
	});

	it("is not available for a LAN, private or remote address: the managed stack only listens on this computer", () => {
		for (const customUrl of ["http://192.168.1.20:3000", "http://10.0.0.5:3000", "http://mybox:3000", "http://multica.lan", "https://multica.example.com", "http://100.64.0.1:3000"]) {
			expect(localServerAvailability({ mode: "local", customUrl, apiUrl: "" }), customUrl).toEqual({ available: false, reason: "remote_url" });
		}
	});

	it("does not mistake a host that merely starts with 127 or contains localhost", () => {
		expect(isLoopbackMulticaHost("127.evil.com")).toBe(false);
		expect(isLoopbackMulticaHost("localhost.evil.com")).toBe(false);
		expect(isLoopbackMulticaHost("128.0.0.1")).toBe(false);
		expect(isLoopbackMulticaHost("127.0.0.1")).toBe(true);
	});
});

describe("request parsers", () => {
	it("accepts only the three Compose service names", () => {
		expect(parseLocalServerService("backend")).toBe("backend");
		expect(parseLocalServerService("frontend")).toBe("frontend");
		expect(parseLocalServerService("postgres")).toBe("postgres");
		for (const bad of ["", "BACKEND", "backend;ls", "--follow", "backend frontend", 3, null, undefined, {}]) expect(parseLocalServerService(bad)).toBeNull();
	});

	it("accepts a positive integer tail, defaults an absent one and caps a big one", () => {
		expect(parseLocalServerTail(undefined)).toBe(200);
		expect(parseLocalServerTail(50)).toBe(50);
		expect(parseLocalServerTail(100_000)).toBe(500);
		for (const bad of [0, -1, 1.5, Number.NaN, "10", null, Number.POSITIVE_INFINITY]) expect(parseLocalServerTail(bad)).toBeNull();
	});
});
