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
import { AO_SEND_ISSUE_URL, MULTICA_SEND_REQUEST_CHANNEL } from "../shared/multica-send-to-ao";
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

function link(overrides: Partial<MulticaIssueLink> = {}): MulticaIssueLink {
	return {
		sessionId: "a-1",
		projectId: "a",
		workspaceSlug: "acme",
		issueIdentifier: "MUL-1",
		createdAt: "2026-01-01T00:00:00.000Z",
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

async function setup(initial: MulticaIssueLink[] = [], withHost = true, initialList?: Promise<MulticaIssueLink[]>) {
	const ipc = fakeIpc();
	const shell = { id: 7, isDestroyed: vi.fn(() => false), send: vi.fn() };
	const host = {
		navigatePath: vi.fn(() => true),
		runInPage: vi.fn(),
		setActive: vi.fn(),
		evaluateInPage: vi.fn(async (_script: string) =>
			JSON.stringify({ ok: true, workspaceSlug: "acme", issueIdentifier: "MUL-1", title: "Fix from page", description: "Description" }),
		),
	};
	let current = [...initial];
	let listCalls = 0;
	const store = {
		list: vi.fn(async () => {
			listCalls += 1;
			if (listCalls === 1 && initialList) return initialList;
			return [...current];
		}),
		add: vi.fn(async (newLink) => {
			current = [...current, { ...newLink, createdAt: "2026-01-01T00:00:00.000Z" }];
			return [...current];
		}),
		remove: vi.fn(async (key) => {
			current = current.filter(
				(entry) =>
					entry.sessionId !== key.sessionId ||
					entry.workspaceSlug !== key.workspaceSlug ||
					entry.issueIdentifier !== key.issueIdentifier,
			);
			return [...current];
		}),
	} satisfies MulticaIssueLinkStore;
	let currentHost: typeof host | undefined = withHost ? host : undefined;
	const service = createMulticaIssueLinkService({
		ipcMain: ipc.ipcMain,
		shellWebContents: shell,
		store,
		getHost: () => currentHost,
		readSettings: async () => ({ url: "https://multica.example.com" }),
	} as unknown as MulticaIssueLinkServiceOptions);
	await Promise.resolve();
	host.runInPage.mockClear();
	const shellEvent = { sender: shell } as FakeEvent;
	return {
		ipc,
		shell,
		host,
		store,
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

describe("multica issue link service: linked sessions pill", () => {
	it("shows links for the current issue and removes the pill for other pages", async () => {
		const t = await setup([link(), link({ sessionId: "b-9", projectId: "b", issueIdentifier: "MUL-2" })]);

		t.service.handlePageTitle("MUL-1: Fix login");
		expect(t.host.runInPage.mock.calls[0][0]).toContain("ao://sessions/a/a-1");
		expect(t.host.runInPage.mock.calls[0][0]).not.toContain("b-9");
		expect(t.host.runInPage.mock.calls[0][0]).not.toContain("ao://sessions/b/b-9");

		t.service.handlePageTitle("MUL-3: Another issue");
		expect(t.host.runInPage.mock.calls[1][0]).toContain(AO_SEND_ISSUE_URL);
		expect(t.host.runInPage.mock.calls[1][0]).not.toContain("ao://sessions/");
		t.service.handlePageTitle("Inbox");
		expect(t.host.runInPage.mock.calls[2][0]).not.toContain("ao://");
	});

	it("offers Send to AO only on an issue page", async () => {
		const t = await setup();

		t.service.handlePageTitle("MUL-1: Fix");
		expect(t.host.runInPage.mock.calls[0][0]).toContain(AO_SEND_ISSUE_URL);

		t.service.handlePageTitle("Issue");
		expect(t.host.runInPage.mock.calls[1][0]).not.toContain(AO_SEND_ISSUE_URL);
		expect(t.host.runInPage.mock.calls[1][0]).not.toContain("ao://");
	});

	it("refreshes the pill after each add and remove on the current issue", async () => {
		const t = await setup([link()]);
		t.service.handlePageTitle("MUL-1: Fix login");
		await t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, {
			sessionId: "b-2",
			projectId: "b",
			issue: "/acme/issues/MUL-1",
		});

		expect(t.host.runInPage).toHaveBeenCalledTimes(2);
		expect(t.host.runInPage.mock.calls[1][0]).toContain("ao://sessions/b/b-2");

		await t.ipc.invoke(MULTICA_LINKS_REMOVE_CHANNEL, t.shellEvent, {
			sessionId: "b-2",
			workspaceSlug: "acme",
			issueIdentifier: "MUL-1",
		});

		expect(t.host.runInPage).toHaveBeenCalledTimes(3);
		expect(t.host.runInPage.mock.calls[2][0]).not.toContain("ao://sessions/b/b-2");
		expect(t.host.runInPage.mock.calls[2][0]).toContain("ao://sessions/a/a-1");
	});

	it("refreshes the current issue pill when LIST replaces the cache", async () => {
		const t = await setup([link()]);
		t.service.handlePageTitle("MUL-1: Fix login");
		vi.mocked(t.store.list).mockResolvedValueOnce([link({ sessionId: "listed", projectId: "listed" })]);

		await expect(t.ipc.invoke(MULTICA_LINKS_LIST_CHANNEL, t.shellEvent)).resolves.toEqual([
			link({ sessionId: "listed", projectId: "listed" }),
		]);

		expect(t.host.runInPage).toHaveBeenCalledTimes(2);
		expect(t.host.runInPage.mock.calls[1][0]).toContain("ao://sessions/listed/listed");
	});

	it("refreshes the pill when the initial cache load finishes after a title event", async () => {
		const initialLoad = deferred<MulticaIssueLink[]>();
		const t = await setup([], true, initialLoad.promise);

		t.service.handlePageTitle("MUL-1: T");
		expect(t.host.runInPage).toHaveBeenCalledTimes(1);
		expect(t.host.runInPage.mock.calls[0][0]).toContain(AO_SEND_ISSUE_URL);

		initialLoad.resolve([link({ sessionId: "late", projectId: "late" })]);
		await initialLoad.promise;
		await Promise.resolve();

		expect(t.host.runInPage).toHaveBeenCalledTimes(2);
		expect(t.host.runInPage.mock.calls[1][0]).toContain("ao://sessions/late/late");
	});
});

describe("multica issue link service: initial cache version", () => {
	it.each(["list", "add"] as const)("keeps a %s result that arrives before the initial cache load", async (operation) => {
		const initialLoad = deferred<MulticaIssueLink[]>();
		const fresh = link({ sessionId: "fresh", projectId: "fresh" });
		const stale = link({ sessionId: "stale", projectId: "stale" });
		const t = await setup([], true, initialLoad.promise);

		if (operation === "list") {
			vi.mocked(t.store.list).mockResolvedValueOnce([fresh]);
			await t.ipc.invoke(MULTICA_LINKS_LIST_CHANNEL, t.shellEvent);
		} else {
			await t.ipc.invoke(MULTICA_LINKS_ADD_CHANNEL, t.shellEvent, {
				sessionId: fresh.sessionId,
				projectId: fresh.projectId,
				issue: "/acme/issues/MUL-1",
			});
		}

		initialLoad.resolve([stale]);
		await initialLoad.promise;
		await Promise.resolve();
		t.service.handlePageTitle("MUL-1: Fix login");

		const script = t.host.runInPage.mock.calls.at(-1)?.[0] ?? "";
		expect(script).toContain("ao://sessions/fresh/fresh");
		expect(script).not.toContain("ao://sessions/stale/stale");
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

		expect(t.host.evaluateInPage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("MUL-1"));
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
			setActive: vi.fn(),
			evaluateInPage: vi.fn(),
		};

		t.service.dispose();
		t.setHost(replacementHost);
		pendingAdd.resolve([link({ sessionId: "late", projectId: "late" })]);
		await add;

		expect(replacementHost.runInPage).not.toHaveBeenCalled();
		expect(replacementHost.setActive).not.toHaveBeenCalled();
		expect(t.shell.send).not.toHaveBeenCalled();
		t.service.handlePageTitle("MUL-1: T");
		expect(t.service.handleAoSessionLink("ao://sessions/a/a-1")).toBe(false);
		expect(replacementHost.runInPage).not.toHaveBeenCalled();
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
		expect(t.host.runInPage).not.toHaveBeenCalled();
		expect(t.host.navigatePath).not.toHaveBeenCalled();
		expect(t.host.setActive).not.toHaveBeenCalled();
	});
});
