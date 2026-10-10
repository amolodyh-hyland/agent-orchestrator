// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MulticaSettings } from "../shared/multica";
import { MULTICA_LINKS_ADD_CHANNEL, MULTICA_LINKS_CHANGED_CHANNEL, MULTICA_LINKS_REMOVE_CHANNEL, type MulticaIssueLink } from "../shared/multica-issue-links";
import { buildOpenWithAoActionUrl, MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, type OpenWithAoSnapshot } from "../shared/multica-open-with-ao";
import type { MulticaSyncSnapshot } from "../shared/multica-status-sync";
import { createMulticaIssueLinkService } from "./multica-issue-link-service";
import type { MulticaIssueLinkStore } from "./multica-issue-links";

const SERVER = "https://multica.example.com";
const OTHER_SERVER = "https://other.example.com";
const UUIDS = { workspaceId: "22222222-2222-4222-8222-222222222222", issueId: "11111111-1111-4111-8111-111111111111" };

function link(overrides: Partial<MulticaIssueLink> = {}): MulticaIssueLink {
	return {
		sessionId: "worker-1",
		projectId: "project-1",
		workspaceSlug: "acme",
		issueIdentifier: "MUL-1",
		createdAt: "2026-01-01T00:00:00.000Z",
		serverKey: SERVER,
		...overrides,
	};
}

const snapshot: OpenWithAoSnapshot = {
	daemon: "ready",
	stale: false,
	projects: [
		{
			id: "project-1",
			name: "Project",
			orchestrator: null,
			sessions: [{ id: "worker-1", projectId: "project-1", label: "worker-1", tone: "ready", stateLabel: "Ready", detail: "", stale: false, terminated: false, updatedAt: 1 }],
			moreCount: 0,
		},
	],
};

const syncSnapshot = (overrides: Partial<MulticaSyncSnapshot> = {}): MulticaSyncSnapshot => ({
	settings: { enabled: true, moveOutOfBacklog: true },
	killSwitch: false,
	links: [],
	...overrides,
});

async function setup(initial: MulticaIssueLink[] = [link()]) {
	const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
	const shell = { id: 7, isDestroyed: vi.fn(() => false), send: vi.fn() };
	const shellEvent = { sender: shell };
	const host = {
		navigatePath: vi.fn(() => true),
		runInPage: vi.fn(),
		runInAoWorld: vi.fn(),
		setActive: vi.fn(),
		getServer: vi.fn(() => ({ key: current.key }) as never),
		evaluateInPage: vi.fn(async () => undefined),
	};
	let stored = [...initial];
	const current = { key: SERVER };
	const settings: MulticaSettings = { mode: "local", customUrl: SERVER, apiUrl: "" };
	const store = {
		list: vi.fn(async () => [...stored]),
		add: vi.fn(async (newLink) => {
			stored = [...stored, { ...newLink, createdAt: "2026-01-02T00:00:00.000Z" }];
			return [...stored];
		}),
		remove: vi.fn(async (key) => {
			stored = stored.filter((entry) => entry.sessionId !== key.sessionId);
			return [...stored];
		}),
		adoptLegacy: vi.fn(async () => [...stored]),
		recordIssueIds: vi.fn(async (target, ids) => {
			stored = stored.map((entry) =>
				entry.serverKey === target.serverKey && entry.workspaceSlug === target.workspaceSlug && entry.issueIdentifier === target.issueIdentifier
					? { ...entry, ...ids }
					: entry,
			);
			return [...stored];
		}),
	} satisfies MulticaIssueLinkStore;
	let onChanged: (() => void) | undefined;
	const sync = {
		setLinks: vi.fn(),
		handleServerChange: vi.fn(),
		getSnapshot: vi.fn(() => syncSnapshot()),
		onChanged: vi.fn((listener: () => void) => {
			onChanged = listener;
			return () => {
				onChanged = undefined;
			};
		}),
		setLink: vi.fn(async () => syncSnapshot()),
		resume: vi.fn(async () => syncSnapshot()),
	};
	const service = createMulticaIssueLinkService({
		ipcMain: {
			handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler),
			removeHandler: (channel: string) => handlers.delete(channel),
		},
		shellWebContents: shell,
		store,
		getHost: () => host as never,
		readSettings: async () => settings,
		sync,
	} as never);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return {
		service,
		sync,
		store,
		shell,
		host,
		handlers,
		invoke: (channel: string, payload?: unknown) => handlers.get(channel)?.(shellEvent, payload),
		fireSyncChanged: () => onChanged?.(),
		hasSyncListener: () => onChanged !== undefined,
		setServer: (key: string, links: MulticaIssueLink[]) => {
			current.key = key;
			stored = links;
		},
	};
}

describe("multica issue link service: status sync wiring", () => {
	it("tells status sync the links of the selected server once they are loaded", async () => {
		const t = await setup([link(), link({ sessionId: "worker-2", serverKey: OTHER_SERVER })]);

		expect(t.sync.setLinks).toHaveBeenCalledWith(SERVER, [link()]);
		expect(t.sync.setLinks.mock.calls.every(([, links]) => (links as MulticaIssueLink[]).every((entry) => entry.serverKey === SERVER))).toBe(true);
	});

	it("passes a server switch on at once and never reports the interim empty list as the links of the new server", async () => {
		const t = await setup();
		t.sync.setLinks.mockClear();
		t.setServer(OTHER_SERVER, [link({ sessionId: "worker-2", serverKey: OTHER_SERVER })]);

		t.service.handleServerChange(OTHER_SERVER);
		expect(t.sync.handleServerChange).toHaveBeenCalledExactlyOnceWith(OTHER_SERVER);
		expect(t.sync.setLinks.mock.calls.filter(([, links]) => (links as MulticaIssueLink[]).length === 0)).toEqual([]);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(t.sync.setLinks).toHaveBeenLastCalledWith(OTHER_SERVER, [link({ sessionId: "worker-2", serverKey: OTHER_SERVER })]);
	});

	it("tells status sync when a link is added or removed", async () => {
		const t = await setup([]);
		t.sync.setLinks.mockClear();

		await t.invoke(MULTICA_LINKS_ADD_CHANNEL, { sessionId: "worker-1", projectId: "project-1", issue: "/acme/issues/MUL-1" });
		expect(t.sync.setLinks).toHaveBeenLastCalledWith(SERVER, [expect.objectContaining({ sessionId: "worker-1", issueIdentifier: "MUL-1" })]);

		await t.invoke(MULTICA_LINKS_REMOVE_CHANNEL, { sessionId: "worker-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
		expect(t.sync.setLinks).toHaveBeenLastCalledWith(SERVER, []);
	});

	it("records the issue ids on the links, pushes them to the shell and hands the links to status sync again", async () => {
		const t = await setup();
		t.sync.setLinks.mockClear();
		t.shell.send.mockClear();

		await t.service.backfillIssueIds({ serverKey: SERVER, workspaceSlug: "acme", issueIdentifier: "MUL-1" }, UUIDS);

		expect(t.store.recordIssueIds).toHaveBeenCalledExactlyOnceWith({ serverKey: SERVER, workspaceSlug: "acme", issueIdentifier: "MUL-1" }, UUIDS);
		expect(t.shell.send).toHaveBeenCalledWith(MULTICA_LINKS_CHANGED_CHANNEL, [expect.objectContaining(UUIDS)]);
		expect(t.sync.setLinks).toHaveBeenLastCalledWith(SERVER, [expect.objectContaining(UUIDS)]);
	});

	it("ignores ids for an issue of a server that is not selected", async () => {
		const t = await setup();
		await t.service.backfillIssueIds({ serverKey: OTHER_SERVER, workspaceSlug: "acme", issueIdentifier: "MUL-1" }, UUIDS);
		expect(t.store.recordIssueIds).not.toHaveBeenCalled();
	});

	it("shows a sync row under a linked session and turns the sync on or off from the menu", async () => {
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix login");
		await t.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, snapshot);
		const script = String(t.host.runInAoWorld.mock.calls.at(-1)?.[0]);
		const nonce = /"nonce":"([^"]+)"/.exec(script)?.[1] ?? "";

		expect(script).toContain("Keep this ticket updated");
		expect(script).toContain('"action":"enable"');

		const action = (syncAction: "enable" | "disable" | "resume") => buildOpenWithAoActionUrl({ kind: "sync", syncAction, projectId: "project-1", sessionId: "worker-1", nonce });
		expect(t.service.handleAoSessionLink(action("enable"))).toBe(true);
		expect(t.sync.setLink).toHaveBeenLastCalledWith({ sessionId: "worker-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: true });
		t.service.handleAoSessionLink(action("disable"));
		expect(t.sync.setLink).toHaveBeenLastCalledWith({ sessionId: "worker-1", workspaceSlug: "acme", issueIdentifier: "MUL-1", enabled: false });
		t.service.handleAoSessionLink(action("resume"));
		expect(t.sync.resume).toHaveBeenCalledExactlyOnceWith({ sessionId: "worker-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });
		expect(t.shell.send).not.toHaveBeenCalledWith("multicaLinks:openSession", expect.anything());
	});

	it("redraws the menu when the sync state changes, and stops listening when disposed", async () => {
		const t = await setup();
		t.service.handlePageTitle("MUL-1: Fix login");
		await t.invoke(MULTICA_OPEN_WITH_AO_PUBLISH_CHANNEL, snapshot);
		t.host.runInAoWorld.mockClear();

		t.fireSyncChanged();
		expect(t.host.runInAoWorld).toHaveBeenCalledTimes(1);

		t.service.dispose();
		expect(t.hasSyncListener()).toBe(false);
	});

	it("works as before without status sync", async () => {
		const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
		const service = createMulticaIssueLinkService({
			ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) },
			shellWebContents: { id: 7, isDestroyed: () => false, send: vi.fn() },
			store: {
				list: async () => [],
				add: async () => [],
				remove: async () => [],
				adoptLegacy: async () => [],
				recordIssueIds: async () => [],
			},
			getHost: () => undefined,
			readSettings: async () => ({ mode: "local", customUrl: SERVER, apiUrl: "" }),
		} as never);
		await new Promise((resolve) => setTimeout(resolve, 0));
		service.handleServerChange(SERVER);
		await expect(service.backfillIssueIds({ serverKey: SERVER, workspaceSlug: "acme", issueIdentifier: "MUL-1" }, UUIDS)).resolves.toBeUndefined();
		service.dispose();
	});
});
