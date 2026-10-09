// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
	MULTICA_LINKS_ADD_CHANNEL,
	MULTICA_LINKS_CHANGED_CHANNEL,
	MULTICA_LINKS_LIST_CHANNEL,
	MULTICA_LINKS_OPEN_ISSUE_CHANNEL,
	MULTICA_LINKS_OPEN_SESSION_CHANNEL,
	MULTICA_LINKS_REMOVE_CHANNEL,
	type MulticaIssueLink,
} from "../shared/multica-issue-links";
import {
	buildOpenWithAoActionUrl,
	MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL,
	OPEN_WITH_AO_ACTION_PREFIX,
	type OpenWithAoSnapshot,
} from "../shared/multica-open-with-ao";
import { AO_SEND_ISSUE_URL, MULTICA_SEND_REQUEST_CHANNEL } from "../shared/multica-send-to-ao";
import { resolveMulticaServer, type MulticaSettings } from "../shared/multica";
import type { MulticaIssueLinkStore } from "./multica-issue-links";
import { createMulticaIssueLinkService, type MulticaIssueLinkServiceOptions } from "./multica-issue-link-service";

type FakeEvent = { sender: { id: number } };
type FakeHandler = (event: FakeEvent, ...args: unknown[]) => unknown;

function fakeIpc() {
	const handlers = new Map<string, FakeHandler>();
	const removed: string[] = [];
	return {
		handlers,
		removed,
		ipcMain: {
			handle: vi.fn((channel: string, handler: FakeHandler) => handlers.set(channel, handler)),
			removeHandler: vi.fn((channel: string) => {
				removed.push(channel);
				handlers.delete(channel);
			}),
		},
		invoke: (channel: string, event: FakeEvent, ...args: unknown[]) => handlers.get(channel)?.(event, ...args),
	};
}

const SERVER_KEY = "https://multica.example.com";

function link(overrides: Partial<MulticaIssueLink> = {}): MulticaIssueLink {
	return {
		sessionId: "a-1",
		projectId: "a",
		workspaceSlug: "acme",
		issueIdentifier: "MUL-1",
		createdAt: "2026-01-01T00:00:00.000Z",
		serverKey: SERVER_KEY,
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function openWithAoSession(id: string, projectId: string): OpenWithAoSnapshot["projects"][number]["sessions"][number] {
	return {
		id,
		projectId,
		label: id,
		tone: "ready",
		stateLabel: "Ready",
		detail: "",
		stale: false,
		terminated: false,
		updatedAt: 1,
	};
}

function snapshot(projectId = "project-1", sessionIds = ["worker-1"]): OpenWithAoSnapshot {
	return {
		daemon: "ready",
		stale: false,
		projects: [
			{
				id: projectId,
				name: "Project",
				orchestrator: null,
				sessions: sessionIds.map((sessionId) => openWithAoSession(sessionId, projectId)),
				moreCount: 0,
			},
		],
	};
}

function actionNonce(script: string): string {
	const match = script.match(/"nonce":"([^"]+)"/);
	if (!match) throw new Error("Open in AO nonce was not found");
	return match[1];
}

async function setup(initial: MulticaIssueLink[] = [], withHost = true) {
	const ipc = fakeIpc();
	const shell = { id: 7, isDestroyed: vi.fn(() => false), send: vi.fn() };
	const host = {
		navigatePath: vi.fn(() => true),
		runInPage: vi.fn(),
		runInAoWorld: vi.fn(),
		setActive: vi.fn(),
		getServer: vi.fn(() => {
			const server = resolveMulticaServer(settings);
			return viewKey === null || !server ? null : { ...server, key: viewKey };
		}),
		evaluateInPage: vi.fn(async (_script: string) =>
			JSON.stringify({ ok: true, workspaceSlug: "acme", issueIdentifier: "MUL-1", title: "Fix from page", description: "Description" }),
		),
	};
	let current = [...initial];
	let settings: MulticaSettings = { mode: "local", customUrl: "https://multica.example.com", apiUrl: "" };
	let viewKey: string | null = "https://multica.example.com";
	const store = {
		list: vi.fn(async () => [...current]),
		add: vi.fn(async (newLink) => {
			current = [...current, { ...newLink, createdAt: "2026-01-01T00:00:00.000Z" }];
			return [...current];
		}),
		remove: vi.fn(async (key) => {
			current = current.filter(
				(entry) =>
					entry.sessionId !== key.sessionId ||
					entry.workspaceSlug !== key.workspaceSlug ||
					entry.issueIdentifier !== key.issueIdentifier ||
					entry.serverKey !== key.serverKey,
			);
			return [...current];
		}),
		adoptLegacy: vi.fn(async (serverKey: string) => {
			current = current.map((entry) => (entry.serverKey === undefined ? { ...entry, serverKey } : entry));
			return [...current];
		}),
	} satisfies MulticaIssueLinkStore;
	let currentHost: typeof host | undefined = withHost ? host : undefined;
	const service = createMulticaIssueLinkService({
		ipcMain: ipc.ipcMain,
		shellWebContents: shell,
		store,
		getHost: () => currentHost,
		readSettings: async () => settings,
	} as unknown as MulticaIssueLinkServiceOptions);
	await new Promise((resolve) => setTimeout(resolve, 0));
	host.runInAoWorld.mockClear();
	const shellEvent = { sender: shell } as FakeEvent;
	return {
		ipc,
		shell,
		host,
		store,
		setSettings: (next: MulticaSettings) => {
			settings = next;
		},
		/** What the view host does on a switch: the live view and the announcement change together. */
		switchTo: (next: MulticaSettings) => {
			settings = next;
			const key = resolveMulticaServer(next)?.key ?? "";
			viewKey = key || null;
			service.handleServerChange(key);
		},
		setViewKey: (key: string | null) => {
			viewKey = key;
		},
		service,
		shellEvent,
		setHostAvailable: (available: boolean) => {
			currentHost = available ? host : undefined;
		},
		setHost: (nextHost: typeof host | undefined) => {
			currentHost = nextHost;
		},
	};
}

describe("multica issue link service: IPC trust", () => {
	it("rejects every channel from an untrusted sender without doing work", async () => {
		const t = await setup();
		const stranger = { sender: { id: 8 } };
		const channels = [
			MULTICA_LINKS_LIST_CHANNEL,
			MULTICA_LINKS_ADD_CHANNEL,
			MULTICA_LINKS_REMOVE_CHANNEL,
			MULTICA_LINKS_OPEN_ISSUE_CHANNEL,
			MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL,
		];
		vi.mocked(t.store.list).mockClear();
		vi.mocked(t.store.add).mockClear();
		vi.mocked(t.store.remove).mockClear();

		await expect(t.ipc.invoke(MULTICA_LINKS_LIST_CHANNEL, stranger)).resolves.toBeUndefined();
		await expect(
			t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, stranger, { sessionId: "s", projectId: "p", issue: "/acme/issues/MUL-1" }),
		).resolves.toBeUndefined();
		await expect(
			t.ipc.invoke(MULTICA_LINKS_REMOVE_CHANNEL, stranger, { sessionId: "s", workspaceSlug: "acme", issueIdentifier: "MUL-1" }),
		).resolves.toBeUndefined();
		await expect(
			t.ipc.invoke(MULTICA_LINKS_OPEN_ISSUE_CHANNEL, stranger, { workspaceSlug: "acme", issueIdentifier: "MUL-1" }),
		).toBeUndefined();

		expect(t.store.list).not.toHaveBeenCalled();
		expect(t.store.add).not.toHaveBeenCalled();
		expect(t.store.remove).not.toHaveBeenCalled();
		expect(t.host.navigatePath).not.toHaveBeenCalled();
		expect(t.shell.send).not.toHaveBeenCalled();
		expect(channels).toHaveLength(t.ipc.handlers.size);
	});
});

describe("multica issue link service: add and remove", () => {
	it("parses issue URLs, stores the normalized link and pushes the updated list", async () => {
		const t = await setup();

		await expect(
			t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, {
				sessionId: "session-1",
				projectId: "project-1",
				issue: "https://multica.example/acme/issues/MUL-1",
			}),
		).resolves.toEqual({ ok: true, links: [link({ sessionId: "session-1", projectId: "project-1" })] });

		expect(t.store.add).toHaveBeenCalledExactlyOnceWith({
			serverKey: SERVER_KEY,
			sessionId: "session-1",
			projectId: "project-1",
			workspaceSlug: "acme",
			issueIdentifier: "MUL-1",
		});
		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_LINKS_CHANGED_CHANNEL, [
			link({ sessionId: "session-1", projectId: "project-1" }),
		]);
	});

	it.each(["MUL-1", "https://multica.example/acme/issues/550e8400-e29b-41d4-a716-446655440000"])(
		"rejects an invalid issue reference %s",
		async (issue) => {
			const t = await setup();

			await expect(
				t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, { sessionId: "s", projectId: "p", issue }),
			).resolves.toEqual({ ok: false, reason: "invalid_issue" });
			expect(t.store.add).not.toHaveBeenCalled();
			expect(t.shell.send).not.toHaveBeenCalled();
		},
	);

	it("rejects non-string add fields and maps store errors to the requested reasons", async () => {
		const t = await setup();

		await expect(
			t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, { sessionId: "s", projectId: 3, issue: "/acme/issues/MUL-1" }),
		).resolves.toEqual({ ok: false, reason: "invalid_session" });
		t.store.add.mockRejectedValueOnce(new Error("invalid link"));
		await expect(
			t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, { sessionId: "", projectId: "p", issue: "/acme/issues/MUL-1" }),
		).resolves.toEqual({ ok: false, reason: "invalid_session" });
		t.store.add.mockRejectedValueOnce(new Error("boom"));
		await expect(
			t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, { sessionId: "s", projectId: "p", issue: "/acme/issues/MUL-1" }),
		).resolves.toEqual({ ok: false, reason: "save_failed" });
	});

	it("removes a link, pushes the remainder and returns it", async () => {
		const first = link();
		const second = link({ sessionId: "b-2", projectId: "b", issueIdentifier: "MUL-2" });
		const t = await setup([first, second]);

		await expect(
			t.ipc.invoke(MULTICA_LINKS_REMOVE_CHANNEL, t.shellEvent, {
				sessionId: first.sessionId,
				workspaceSlug: first.workspaceSlug,
				issueIdentifier: first.issueIdentifier,
			}),
		).resolves.toEqual([second]);
		expect(t.store.remove).toHaveBeenCalledExactlyOnceWith({
			serverKey: SERVER_KEY,
			sessionId: first.sessionId,
			workspaceSlug: first.workspaceSlug,
			issueIdentifier: first.issueIdentifier,
		});
		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_LINKS_CHANGED_CHANNEL, [second]);
	});
});

describe("multica issue link service: issue navigation", () => {
	it("opens a valid issue path and returns false for invalid input or an absent host", async () => {
		const t = await setup();
		t.host.navigatePath.mockReturnValueOnce(false);

		await expect(
			t.ipc.invoke(MULTICA_LINKS_OPEN_ISSUE_CHANNEL, t.shellEvent, { workspaceSlug: "acme", issueIdentifier: "MUL-1" }),
		).toBe(false);
		expect(t.host.navigatePath).toHaveBeenCalledExactlyOnceWith("/acme/issues/MUL-1");
		await expect(t.ipc.invoke(MULTICA_LINKS_OPEN_ISSUE_CHANNEL, t.shellEvent, { workspaceSlug: "Acme", issueIdentifier: "MUL-1" })).toBe(false);
		await expect(t.ipc.invoke(MULTICA_LINKS_OPEN_ISSUE_CHANNEL, t.shellEvent, { workspaceSlug: "acme" })).toBe(false);

		t.setHostAvailable(false);
		await expect(
			t.ipc.invoke(MULTICA_LINKS_OPEN_ISSUE_CHANNEL, t.shellEvent, { workspaceSlug: "acme", issueIdentifier: "MUL-1" }),
		).toBe(false);
	});
});

describe("multica issue link service: Open in AO page integration", () => {
	it("refreshes on every title event and removes the controller outside issues", async () => {
		const t = await setup();

		t.service.handlePageTitle("MUL-1: Fix login");
		expect(t.host.runInAoWorld.mock.calls[0]?.[0]).toContain("__aoOpenWithAo");
		expect(t.host.runInAoWorld.mock.calls[0]?.[0]).toContain("MUL-1");

		t.service.handlePageTitle("Inbox");
		expect(t.host.runInAoWorld.mock.calls[1]?.[0]).toContain("delete window.__aoOpenWithAo");

		t.service.handlePageTitle("MUL-1: Fix login");
		t.service.handlePageTitle("MUL-1: Updated title");
		expect(t.host.runInAoWorld).toHaveBeenCalledTimes(4);
		expect(t.host.runInAoWorld.mock.calls[3]?.[0]).toContain("Updated title");
	});

	it("validates published snapshots and skips duplicate snapshots", async () => {
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix login");
		t.host.runInAoWorld.mockClear();
		const stranger = { sender: { id: 8 } };

		expect(t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, stranger, snapshot())).toEqual({ ok: false });
		expect(t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, t.shellEvent, { stale: false, projects: [] })).toEqual({ ok: false });
		expect(t.host.runInAoWorld).not.toHaveBeenCalled();

		const published = snapshot("project-from-snapshot");
		expect(t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, t.shellEvent, published)).toEqual({ ok: true });
		expect(t.host.runInAoWorld).toHaveBeenCalledTimes(1);
		expect(t.host.runInAoWorld.mock.calls[0]?.[0]).toContain("project-from-snapshot");
		expect(t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, t.shellEvent, published)).toEqual({ ok: true });
		expect(t.host.runInAoWorld).toHaveBeenCalledTimes(1);
	});

	it("refreshes the page script when a link is added or removed", async () => {
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix login");
		expect(t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, t.shellEvent, snapshot())).toEqual({ ok: true });
		t.host.runInAoWorld.mockClear();

		await t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, {
			sessionId: "worker-1",
			projectId: "project-1",
			issue: "/acme/issues/MUL-1",
		});
		expect(t.host.runInAoWorld).toHaveBeenCalledTimes(1);
		expect(t.host.runInAoWorld.mock.calls[0]?.[0]).toContain("\"linked\":true");

		await t.ipc.invoke(MULTICA_LINKS_REMOVE_CHANNEL, t.shellEvent, {
			sessionId: "worker-1",
			workspaceSlug: "acme",
			issueIdentifier: "MUL-1",
		});
		expect(t.host.runInAoWorld).toHaveBeenCalledTimes(2);
		expect(t.host.runInAoWorld.mock.calls[1]?.[0]).toContain("\"linked\":false");
	});

	it("refreshes after LIST replaces the link cache", async () => {
		const t = await setup([link()]);
		t.service.handlePageTitle("MUL-1: Fix login");
		t.host.runInAoWorld.mockClear();

		await t.ipc.invoke(MULTICA_LINKS_LIST_CHANNEL, t.shellEvent);

		expect(t.host.runInAoWorld).toHaveBeenCalledTimes(1);
		expect(t.host.runInAoWorld.mock.calls[0]?.[0]).toContain("__aoOpenWithAo");
	});

	it("routes Open in AO action URLs and swallows malformed prefixed URLs", async () => {
		const t = await setup();

		expect(t.service.handleAoSessionLink(`${OPEN_WITH_AO_ACTION_PREFIX}not-an-action`)).toBe(true);
		expect(t.host.evaluateInPage).not.toHaveBeenCalled();
		expect(t.shell.send).not.toHaveBeenCalled();
	});

	it("links an unlinked worker before opening it in AO", async () => {
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix login");
		expect(t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, t.shellEvent, snapshot())).toEqual({ ok: true });
		const nonce = actionNonce(t.host.runInAoWorld.mock.calls.at(-1)?.[0] ?? "");
		vi.mocked(t.host.evaluateInPage).mockResolvedValueOnce(JSON.stringify({ slug: "acme", title: "MUL-1: Fix login" }));

		const url = buildOpenWithAoActionUrl({
			kind: "open",
			projectId: "project-1",
			sessionId: "worker-1",
			nonce,
			workspaceSlug: "acme",
		});
		expect(t.service.handleAoSessionLink(url)).toBe(true);
		await vi.waitFor(() =>
			expect(t.shell.send).toHaveBeenCalledWith(MULTICA_LINKS_OPEN_SESSION_CHANNEL, {
				projectId: "project-1",
				sessionId: "worker-1",
			}),
		);

		expect(t.store.add).toHaveBeenCalledExactlyOnceWith({
			serverKey: SERVER_KEY,
			sessionId: "worker-1",
			projectId: "project-1",
			workspaceSlug: "acme",
			issueIdentifier: "MUL-1",
		});
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
		const openSessionCall = t.shell.send.mock.calls.findIndex(([channel]) => channel === MULTICA_LINKS_OPEN_SESSION_CHANNEL);
		expect(t.store.add.mock.invocationCallOrder[0]!).toBeLessThan(t.host.setActive.mock.invocationCallOrder[0]!);
		expect(t.host.setActive.mock.invocationCallOrder[0]!).toBeLessThan(t.shell.send.mock.invocationCallOrder[openSessionCall]!);
	});

	it("opens an unlinked worker without linking when the action URL has no workspace slug", async () => {
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix login");
		expect(t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, t.shellEvent, snapshot())).toEqual({ ok: true });
		const nonce = actionNonce(t.host.runInAoWorld.mock.calls.at(-1)?.[0] ?? "");
		vi.mocked(t.host.evaluateInPage).mockResolvedValueOnce(JSON.stringify({ slug: "acme", title: "MUL-1: Fix login" }));

		const url = buildOpenWithAoActionUrl({ kind: "open", projectId: "project-1", sessionId: "worker-1", nonce });
		expect(t.service.handleAoSessionLink(url)).toBe(true);
		await vi.waitFor(() =>
			expect(t.shell.send).toHaveBeenCalledWith(MULTICA_LINKS_OPEN_SESSION_CHANNEL, {
				projectId: "project-1",
				sessionId: "worker-1",
			}),
		);

		expect(t.store.add).not.toHaveBeenCalled();
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_LINKS_OPEN_SESSION_CHANNEL, {
			projectId: "project-1",
			sessionId: "worker-1",
		});
	});

	it("opens an unlinked worker without linking when the action workspace differs from the page", async () => {
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix login");
		expect(t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, t.shellEvent, snapshot())).toEqual({ ok: true });
		const nonce = actionNonce(t.host.runInAoWorld.mock.calls.at(-1)?.[0] ?? "");
		vi.mocked(t.host.evaluateInPage).mockResolvedValueOnce(JSON.stringify({ slug: "acme", title: "MUL-1: Fix login" }));

		const url = buildOpenWithAoActionUrl({
			kind: "open",
			projectId: "project-1",
			sessionId: "worker-1",
			nonce,
			workspaceSlug: "other-workspace",
		});
		expect(t.service.handleAoSessionLink(url)).toBe(true);
		await vi.waitFor(() =>
			expect(t.shell.send).toHaveBeenCalledWith(MULTICA_LINKS_OPEN_SESSION_CHANNEL, {
				projectId: "project-1",
				sessionId: "worker-1",
			}),
		);

		expect(t.store.add).not.toHaveBeenCalled();
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_LINKS_OPEN_SESSION_CHANNEL, {
			projectId: "project-1",
			sessionId: "worker-1",
		});
	});

	it("opens without linking when the page title changes during the workspace read", async () => {
		const pending = deferred<unknown>();
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix login");
		expect(t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, t.shellEvent, snapshot())).toEqual({ ok: true });
		const nonce = actionNonce(t.host.runInAoWorld.mock.calls.at(-1)?.[0] ?? "");
		vi.mocked(t.host.evaluateInPage).mockImplementationOnce(() => pending.promise);

		t.service.handleAoSessionLink(
			buildOpenWithAoActionUrl({ kind: "open", projectId: "project-1", sessionId: "worker-1", nonce }),
		);
		t.service.handlePageTitle("BETA-9: Another issue");
		pending.resolve(JSON.stringify({ slug: "acme", title: "MUL-1: Fix login" }));

		await vi.waitFor(() => expect(t.shell.send).toHaveBeenCalledWith(MULTICA_LINKS_OPEN_SESSION_CHANNEL, {
			projectId: "project-1",
			sessionId: "worker-1",
		}));
		expect(t.store.add).not.toHaveBeenCalled();
	});

	it("opens an orchestrator without adding an issue link", async () => {
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix login");
		const published = snapshot("project-1", []);
		published.projects[0]!.orchestrator = openWithAoSession("orchestrator-1", "project-1");
		expect(t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, t.shellEvent, published)).toEqual({ ok: true });
		const nonce = actionNonce(t.host.runInAoWorld.mock.calls.at(-1)?.[0] ?? "");

		expect(
			t.service.handleAoSessionLink(
				buildOpenWithAoActionUrl({ kind: "open", projectId: "project-1", sessionId: "orchestrator-1", nonce }),
			),
		).toBe(true);
		expect(t.store.add).not.toHaveBeenCalled();
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_LINKS_OPEN_SESSION_CHANNEL, {
			projectId: "project-1",
			sessionId: "orchestrator-1",
		});
	});

	it("ignores an action URL with the wrong nonce", async () => {
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix login");
		expect(t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, t.shellEvent, snapshot())).toEqual({ ok: true });
		const url = buildOpenWithAoActionUrl({
			kind: "open",
			projectId: "project-1",
			sessionId: "worker-1",
			nonce: "wrong-nonce-000000",
		});

		expect(t.service.handleAoSessionLink(url)).toBe(true);
		expect(t.store.add).not.toHaveBeenCalled();
		expect(t.host.setActive).not.toHaveBeenCalled();
		expect(t.shell.send).not.toHaveBeenCalled();
	});

	it("requests a new task for the selected project", async () => {
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix login");
		expect(t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, t.shellEvent, snapshot())).toEqual({ ok: true });
		const nonce = actionNonce(t.host.runInAoWorld.mock.calls.at(-1)?.[0] ?? "");

		const url = buildOpenWithAoActionUrl({ kind: "new-task", projectId: "project-1", nonce });
		expect(t.service.handleAoSessionLink(url)).toBe(true);
		await vi.waitFor(() => expect(t.shell.send).toHaveBeenCalledWith(MULTICA_SEND_REQUEST_CHANNEL, expect.objectContaining({
			ok: true,
			projectId: "project-1",
		})));
	});
});

describe("multica issue link service: servers", () => {
	const OTHER = "https://other.example.com";

	it("adopts links made before servers could be switched for the server selected at startup", async () => {
		const t = await setup([link({ serverKey: undefined })]);

		expect(t.store.adoptLegacy).toHaveBeenCalledExactlyOnceWith(SERVER_KEY);
		await expect(t.ipc.invoke(MULTICA_LINKS_LIST_CHANNEL, t.shellEvent)).resolves.toEqual([link()]);
	});

	it("lists only the links of the selected server and shows the others again when switching back", async () => {
		const here = link({ sessionId: "here" });
		const there = link({ sessionId: "there", serverKey: OTHER });
		const t = await setup([here, there]);
		await expect(t.ipc.invoke(MULTICA_LINKS_LIST_CHANNEL, t.shellEvent)).resolves.toEqual([here]);

		t.switchTo({ mode: "local", customUrl: OTHER, apiUrl: "" });
		t.shell.send.mockClear();
		await vi.waitFor(() => expect(t.shell.send).toHaveBeenCalledWith(MULTICA_LINKS_CHANGED_CHANNEL, [there]));
		await expect(t.ipc.invoke(MULTICA_LINKS_LIST_CHANNEL, t.shellEvent)).resolves.toEqual([there]);

		t.switchTo({ mode: "local", customUrl: SERVER_KEY, apiUrl: "" });
		await vi.waitFor(() => expect(t.shell.send).toHaveBeenLastCalledWith(MULTICA_LINKS_CHANGED_CHANNEL, [here]));
	});

	it("tags new links with the selected server, so the same identifier on two servers stays apart", async () => {
		const here = link({ sessionId: "s1" });
		const t = await setup([here]);
		t.switchTo({ mode: "cloud", customUrl: "", apiUrl: "" });
		await vi.waitFor(() => expect(t.shell.send).toHaveBeenCalledWith(MULTICA_LINKS_CHANGED_CHANNEL, []));

		const added = await t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, { sessionId: "s1", projectId: "a", issue: "/acme/issues/MUL-1" });
		expect(added).toMatchObject({ ok: true, links: [{ sessionId: "s1", serverKey: "cloud" }] });
		await t.ipc.invoke(MULTICA_LINKS_REMOVE_CHANNEL, t.shellEvent, { sessionId: "s1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
		t.switchTo({ mode: "local", customUrl: SERVER_KEY, apiUrl: "" });
		await vi.waitFor(() => expect(t.shell.send).toHaveBeenLastCalledWith(MULTICA_LINKS_CHANGED_CHANNEL, [here]));
	});

	it("tags and lists by the server announced by the host at once, before any reload finishes", async () => {
		const t = await setup([link({ sessionId: "here" })]);

		t.switchTo({ mode: "cloud", customUrl: "", apiUrl: "" });
		const added = await t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, { sessionId: "s9", projectId: "a", issue: "/acme/issues/MUL-9" });

		expect(added).toMatchObject({ ok: true, links: [{ sessionId: "s9", serverKey: "cloud" }] });
		expect(t.store.add).toHaveBeenLastCalledWith(expect.objectContaining({ serverKey: "cloud" }));
	});

	it("refuses to add a link when the live page belongs to another server than the selected one", async () => {
		const t = await setup([]);
		t.setViewKey("cloud");

		await expect(
			t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, { sessionId: "s2", projectId: "a", issue: "/acme/issues/MUL-3" }),
		).resolves.toEqual({ ok: false, reason: "save_failed" });
		expect(t.store.add).not.toHaveBeenCalled();
	});

	it("shows no links and refuses new ones while no server is selected", async () => {
		const t = await setup([link()]);
		t.switchTo({ mode: "local", customUrl: "", apiUrl: "" });
		await vi.waitFor(() => expect(t.shell.send).toHaveBeenCalledWith(MULTICA_LINKS_CHANGED_CHANNEL, []));
		await expect(
			t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, { sessionId: "s2", projectId: "a", issue: "/acme/issues/MUL-3" }),
		).resolves.toEqual({ ok: false, reason: "save_failed" });
	});
});

describe("multica issue link service: AO session links", () => {
	it("opens a linked session in AO, and swallows valid but unlinked targets", async () => {
		const t = await setup([link()]);

		expect(t.service.handleAoSessionLink("ao://sessions/a/a-1")).toBe(true);
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_LINKS_OPEN_SESSION_CHANNEL, {
			projectId: "a",
			sessionId: "a-1",
		});

		t.host.setActive.mockClear();
		t.shell.send.mockClear();
		expect(t.service.handleAoSessionLink("ao://sessions/a/unlinked")).toBe(true);
		expect(t.host.setActive).not.toHaveBeenCalled();
		expect(t.shell.send).not.toHaveBeenCalled();
	});

	it.each(["https://example.com", "ao://sessions/p", ""])("ignores non-session target %s", (url) => {
		const t = setup();
		return t.then(({ service, host, shell }) => {
			expect(service.handleAoSessionLink(url)).toBe(false);
			expect(host.setActive).not.toHaveBeenCalled();
			expect(shell.send).not.toHaveBeenCalled();
		});
	});
});

describe("multica issue link service: Send to AO", () => {
	it("reads the current issue and sends one request to the shell", async () => {
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix");

		expect(t.service.handleAoSessionLink(AO_SEND_ISSUE_URL)).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(t.host.evaluateInPage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("MUL-1"), "https://multica.example.com");
		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, {
			ok: true,
			issue: {
				workspaceSlug: "acme",
				issueIdentifier: "MUL-1",
				title: "Fix from page",
				description: "Description",
				url: "https://multica.example.com/acme/issues/MUL-1",
			},
		});
	});

	it("sends no_issue when there is no current issue", async () => {
		const t = await setup();

		expect(t.service.handleAoSessionLink(AO_SEND_ISSUE_URL)).toBe(true);

		expect(t.host.evaluateInPage).not.toHaveBeenCalled();
		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, { ok: false, reason: "no_issue" });
	});

	it("forgets the issue of the old server's page when the server changes, until the new page reports a title", async () => {
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix");

		t.switchTo({ mode: "cloud", customUrl: "", apiUrl: "" });
		expect(t.service.handleAoSessionLink(AO_SEND_ISSUE_URL)).toBe(true);

		expect(t.host.evaluateInPage).not.toHaveBeenCalled();
		expect(t.shell.send).toHaveBeenLastCalledWith(MULTICA_SEND_REQUEST_CHANNEL, { ok: false, reason: "no_issue" });
	});

	it("returns false after disposal", async () => {
		const t = await setup();
		t.service.dispose();

		expect(t.service.handleAoSessionLink(AO_SEND_ISSUE_URL)).toBe(false);
		expect(t.host.evaluateInPage).not.toHaveBeenCalled();
		expect(t.shell.send).not.toHaveBeenCalled();
	});
});

describe("multica issue link service: lifecycle", () => {
	it("removes every IPC handler it registered", async () => {
		const t = await setup();
		const registered = [...t.ipc.handlers.keys()].sort();

		t.service.dispose();

		expect(t.ipc.removed.sort()).toEqual(registered);
		expect(t.ipc.handlers.size).toBe(0);
	});

	it("removes the Open in AO handler and ignores publishes after disposal", async () => {
		const t = await setup([link()]);
		t.service.handlePageTitle("MUL-1: Fix login");
		t.host.runInAoWorld.mockClear();

		t.service.dispose();

		expect(t.ipc.handlers.has(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL)).toBe(false);
		expect(
			t.ipc.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, t.shellEvent, snapshot()),
		).toBeUndefined();
		t.service.handlePageTitle("MUL-1: Reloaded");
		expect(t.host.runInAoWorld).not.toHaveBeenCalled();
	});

	it("does not apply an in-flight add or handle events after disposal", async () => {
		const t = await setup();
		const pendingAdd = deferred<MulticaIssueLink[]>();
		vi.mocked(t.store.add).mockReturnValueOnce(pendingAdd.promise);
		const add = t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, {
			sessionId: "late",
			projectId: "late",
			issue: "/acme/issues/MUL-1",
		});
		const replacementHost = {
			navigatePath: vi.fn(() => true),
			runInPage: vi.fn(),
			runInAoWorld: vi.fn(),
			setActive: vi.fn(),
			evaluateInPage: vi.fn(),
			getServer: vi.fn(() => null),
		};

		t.service.dispose();
		t.setHost(replacementHost);
		pendingAdd.resolve([link({ sessionId: "late", projectId: "late" })]);
		await add;

		expect(replacementHost.runInAoWorld).not.toHaveBeenCalled();
		expect(replacementHost.setActive).not.toHaveBeenCalled();
		expect(t.shell.send).not.toHaveBeenCalled();
		t.service.handlePageTitle("MUL-1: T");
		expect(t.service.handleAoSessionLink("ao://sessions/a/a-1")).toBe(false);
		expect(replacementHost.runInAoWorld).not.toHaveBeenCalled();
		expect(replacementHost.setActive).not.toHaveBeenCalled();
		expect(t.shell.send).not.toHaveBeenCalled();
	});

	it("tolerates a missing host in every service path", async () => {
		const t = await setup([link()], false);

		expect(() => t.service.handlePageTitle("MUL-1: Fix login")).not.toThrow();
		expect(t.service.handleAoSessionLink("ao://sessions/a/a-1")).toBe(true);
		await expect(
			t.ipc.invoke(MULTICA_LINKS_OPEN_ISSUE_CHANNEL, t.shellEvent, { workspaceSlug: "acme", issueIdentifier: "MUL-1" }),
		).toBe(false);
		await expect(
			t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, { sessionId: "b-2", projectId: "b", issue: "/acme/issues/MUL-1" }),
		).resolves.toMatchObject({ ok: true });
		await expect(
			t.ipc.invoke(MULTICA_LINKS_REMOVE_CHANNEL, t.shellEvent, {
				sessionId: "b-2",
				workspaceSlug: "acme",
				issueIdentifier: "MUL-1",
			}),
		).resolves.toHaveLength(1);
		expect(t.host.runInAoWorld).not.toHaveBeenCalled();
		expect(t.host.navigatePath).not.toHaveBeenCalled();
		expect(t.host.setActive).not.toHaveBeenCalled();
	});
});
