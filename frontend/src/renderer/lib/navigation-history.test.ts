import { afterEach, describe, expect, it } from "vitest";
import {
	historyIndex,
	isTopbarSessionClosed,
	markTopbarSessionClosed,
	markTopbarSessionOpened,
	readAONavigationLocationForHref,
	resetNavigationHistoryForTests,
	sessionIdFromHistoryHref,
	writeAONavigationLocation,
	type NavigationHistoryLike,
} from "./navigation-history";

function createHistory(): NavigationHistoryLike & { pushes: unknown[][]; replacements: unknown[][] } {
	const history = {
		location: { href: "#/projects/project-1/sessions/worker-1", state: { __TSR_index: 2, keep: "value" } },
		pushes: [] as unknown[][],
		replacements: [] as unknown[][],
		push(href: string, state?: Record<string, unknown>) {
			this.pushes.push([href, state]);
			this.location = { href, state: state ?? {} };
		},
		replace(href: string, state?: Record<string, unknown>) {
			this.replacements.push([href, state]);
			this.location = { href, state: state ?? {} };
		},
	};
	return history;
}

afterEach(() => resetNavigationHistoryForTests());

describe("navigation history", () => {
	it("stores a same-route location while preserving router history state", () => {
		const history = createHistory();

		expect(writeAONavigationLocation(history, { multicaActive: true })).toBe(true);

		expect(history.pushes).toHaveLength(1);
		expect(history.pushes[0]?.[0]).toBe("#/projects/project-1/sessions/worker-1");
		expect(history.pushes[0]?.[1]).toMatchObject({ __TSR_index: 2, keep: "value" });
		expect(readAONavigationLocationForHref(history.location.state, history.location.href)).toMatchObject({
			multicaActive: true,
			href: "#/projects/project-1/sessions/worker-1",
		});
		expect(writeAONavigationLocation(history, { multicaActive: true })).toBe(false);
		expect(history.pushes).toHaveLength(1);
	});

	it("replaces stale route metadata when seeding a new route", () => {
		const history = createHistory();
		writeAONavigationLocation(history, { multicaActive: true });
		history.location = { href: "#/settings", state: history.location.state };

		expect(writeAONavigationLocation(history, { settingsModal: null, multicaActive: false, sessionView: null }, "replace")).toBe(true);
		expect(history.replacements).toHaveLength(1);
		expect(readAONavigationLocationForHref(history.location.state, "#/settings")).toMatchObject({
			settingsModal: null,
			multicaActive: false,
			href: "#/settings",
		});
		expect(readAONavigationLocationForHref(history.location.state, "#/projects/project-1/sessions/worker-1")).toBeNull();
	});

	it("stores a session file location with its display mode and open request", () => {
		const history = createHistory();
		const sessionView = {
			sessionKey: "worker-1",
			sessionId: "worker-1",
			target: {
				kind: "file" as const,
				path: "src/example.ts",
				request: { editing: false, line: 12, mode: "diff" as const, scope: "staged" as const },
			},
			inspectorView: "files" as const,
			inspectorOpen: true,
		};

		writeAONavigationLocation(history, { sessionView });

		expect(readAONavigationLocationForHref(history.location.state, history.location.href)?.sessionView).toEqual(sessionView);
	});

	it.each([
		["#/projects/project-1/sessions/worker-1", "worker-1"],
		["#/sessions/standalone-1", "standalone-1"],
		["#/host/box-a/project/project-1/session/remote-worker", "remote-worker"],
	])("finds the routed session in %s", (href, sessionId) => {
		expect(sessionIdFromHistoryHref(href)).toBe(sessionId);
	});

	it("tracks closed topbar sessions until they are opened again", () => {
		markTopbarSessionClosed("worker-1");
		expect(isTopbarSessionClosed("worker-1")).toBe(true);
		markTopbarSessionOpened("worker-1");
		expect(isTopbarSessionClosed("worker-1")).toBe(false);
	});

	it("reads the TanStack history index only from an integer state value", () => {
		expect(historyIndex({ __TSR_index: 5 })).toBe(5);
		expect(historyIndex({ __TSR_index: 2.5 })).toBeNull();
		expect(historyIndex(null)).toBeNull();
	});
});
