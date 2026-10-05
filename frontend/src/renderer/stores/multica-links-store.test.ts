import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaIssueLink } from "../../shared/multica-issue-links";

type Bridge = NonNullable<typeof window.ao>["multicaLinks"];

async function freshStore() {
	vi.resetModules();
	return (await import("./multica-links-store")).useMulticaLinksStore;
}

const link = (issueIdentifier: string): MulticaIssueLink => ({
	sessionId: "session-1",
	projectId: "project-1",
	workspaceSlug: "acme",
	issueIdentifier,
	createdAt: "2026-10-01T00:00:00.000Z",
});

describe("multica links store", () => {
	let original: Bridge;
	let pushLinks: (links: MulticaIssueLink[]) => void;
	const onChanged = vi.fn();

	beforeEach(() => {
		original = { ...window.ao!.multicaLinks };
		onChanged.mockReset();
		onChanged.mockImplementation((listener: (links: MulticaIssueLink[]) => void) => {
			pushLinks = listener;
			return () => undefined;
		});
		window.ao!.multicaLinks.onChanged = onChanged;
	});

	afterEach(() => {
		Object.assign(window.ao!.multicaLinks, original);
	});

	it("loads once and follows main-process pushes", async () => {
		const listed = [link("MUL-1")];
		window.ao!.multicaLinks.list = vi.fn(async () => listed);
		const store = await freshStore();

		await store.getState().load();
		await store.getState().load();

		expect(store.getState().links).toEqual(listed);
		expect(onChanged).toHaveBeenCalledOnce();
		pushLinks([link("MUL-2")]);
		expect(store.getState().links).toEqual([link("MUL-2")]);
	});

	it("prefers a push that arrives before the initial list resolves", async () => {
		let resolveList: (links: MulticaIssueLink[]) => void = () => undefined;
		window.ao!.multicaLinks.list = vi.fn(() => new Promise<MulticaIssueLink[]>((resolve) => (resolveList = resolve)));
		const store = await freshStore();

		const loading = store.getState().load();
		pushLinks([link("MUL-2")]);
		resolveList([link("MUL-1")]);
		await loading;

		expect(store.getState().links).toEqual([link("MUL-2")]);
	});

	it("replaces links after a successful add", async () => {
		const store = await freshStore();
		store.setState({ links: [link("MUL-1")] });
		const result = { ok: true as const, links: [link("MUL-2")] };
		window.ao!.multicaLinks.add = vi.fn(async () => result);

		await expect(store.getState().add({ sessionId: "session-1", projectId: "project-1", issue: "MUL-2" })).resolves.toEqual(result);

		expect(store.getState().links).toEqual(result.links);
	});

	it("returns add failures unchanged and keeps the current links", async () => {
		const store = await freshStore();
		const current = [link("MUL-1")];
		store.setState({ links: current });
		const result = { ok: false as const, reason: "invalid_issue" as const };
		window.ao!.multicaLinks.add = vi.fn(async () => result);

		await expect(store.getState().add({ sessionId: "session-1", projectId: "project-1", issue: "bad" })).resolves.toBe(result);

		expect(store.getState().links).toBe(current);
	});

	it("replaces links after remove", async () => {
		const store = await freshStore();
		const removed = [link("MUL-2")];
		window.ao!.multicaLinks.remove = vi.fn(async () => removed);

		await store.getState().remove({ sessionId: "session-1", workspaceSlug: "acme", issueIdentifier: "MUL-1" });

		expect(store.getState().links).toEqual(removed);
	});

	it("returns the bridge result when opening an issue and false on errors", async () => {
		const store = await freshStore();
		window.ao!.multicaLinks.openIssue = vi.fn(async () => true);
		await expect(store.getState().openIssue({ workspaceSlug: "acme", issueIdentifier: "MUL-1" })).resolves.toBe(true);

		window.ao!.multicaLinks.openIssue = vi.fn(async () => {
			throw new Error("no bridge");
		});
		await expect(store.getState().openIssue({ workspaceSlug: "acme", issueIdentifier: "MUL-1" })).resolves.toBe(false);
	});
});
