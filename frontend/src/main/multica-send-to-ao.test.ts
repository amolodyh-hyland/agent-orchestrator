// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMulticaServer, type MulticaSettings } from "../shared/multica";
import { MULTICA_SEND_REQUEST_CHANNEL } from "../shared/multica-send-to-ao";
import { READ_ISSUE_TIMEOUT_MS } from "./multica-issue-reader";
import { createMulticaSendToAo, type MulticaSendToAoOptions } from "./multica-send-to-ao";

const successfulRead = JSON.stringify({
	ok: true,
	workspaceSlug: "acme",
	issueIdentifier: "MUL-1",
	title: "Fix login",
	description: "Description",
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

const LOCAL: MulticaSettings = { mode: "local", customUrl: "https://multica.example.com", apiUrl: "" };

function setup(overrides: Partial<MulticaSendToAoOptions> = {}, settings: MulticaSettings = LOCAL) {
	const order: string[] = [];
	const shell = { isDestroyed: vi.fn(() => false), send: vi.fn((..._args: unknown[]) => order.push("send")) };
	const host = {
		evaluateInPage: vi.fn(async (_script: string, _serverKey?: string): Promise<unknown> => {
			order.push("evaluate");
			return successfulRead;
		}),
		getServer: vi.fn(() => resolveMulticaServer(settings)),
		setActive: vi.fn((_active: boolean) => order.push("setActive")),
	};
	let currentHost: typeof host | undefined = host;
	const options: MulticaSendToAoOptions = {
		shellWebContents: shell as unknown as MulticaSendToAoOptions["shellWebContents"],
		getHost: () => currentHost,
		getCurrentIssue: () => ({ identifier: "MUL-1", title: "Fix login" }),
		...overrides,
	};
	const service = createMulticaSendToAo(options);
	return {
		service,
		shell,
		host,
		order,
		setHost: (nextHost: typeof host | undefined) => {
			currentHost = nextHost;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Multica send to AO", () => {
	it("reads and delivers the current issue, then hides the Multica view", async () => {
		const t = setup();
		t.service.request();
		await flushPromises();

		expect(t.host.evaluateInPage).toHaveBeenCalledOnce();
		expect(t.host.evaluateInPage.mock.calls[0][0]).toContain("MUL-1");
		expect(t.host.evaluateInPage.mock.calls[0][0]).toContain("https://api.multica.example.com");
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, {
			ok: true,
			issue: {
				workspaceSlug: "acme",
				issueIdentifier: "MUL-1",
				title: "Fix login",
				description: "Description",
				url: "https://multica.example.com/acme/issues/MUL-1",
			},
		});
		expect(t.order).toEqual(["evaluate", "setActive", "send"]);
	});

	it("reads from Multica Cloud's API and links to its web app in cloud mode", async () => {
		const t = setup({}, { mode: "cloud", customUrl: "http://localhost:3000", apiUrl: "" });
		t.service.request();
		await flushPromises();

		expect(t.host.evaluateInPage.mock.calls[0][0]).toContain("https://api.multica.ai");
		expect(t.host.evaluateInPage.mock.calls[0][0]).not.toContain("localhost");
		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(
			MULTICA_SEND_REQUEST_CHANNEL,
			expect.objectContaining({ ok: true, issue: expect.objectContaining({ url: "https://multica.ai/acme/issues/MUL-1" }) }),
		);
	});

	it("reads from the explicit API origin of a same-origin self-hosted server", async () => {
		const t = setup({}, { mode: "local", customUrl: "https://multica.example.com", apiUrl: "https://multica.example.com" });
		t.service.request();
		await flushPromises();

		expect(t.host.evaluateInPage.mock.calls[0][0]).not.toContain("api.multica.example.com");
		expect(t.host.evaluateInPage.mock.calls[0][0]).toContain("https://multica.example.com");
	});

	it("binds the read to the server of the live view, so a switch cannot run one server's script in another's page", async () => {
		const t = setup();
		t.service.request();
		await flushPromises();

		const [script, serverKey] = t.host.evaluateInPage.mock.calls[0];
		expect(serverKey).toBe("https://multica.example.com");
		expect(script).toContain("https://api.multica.example.com");
	});

	it("reads the server synchronously from the host right before evaluating, with no settings read in between", async () => {
		const t = setup();
		t.service.request();

		expect(t.host.getServer).toHaveBeenCalledOnce();
		expect(t.host.evaluateInPage).toHaveBeenCalledOnce();
	});

	it("includes the requested project id after a successful read", async () => {
		const t = setup();
		t.service.request({ projectId: "project-one" });
		await flushPromises();

		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, {
			ok: true,
			projectId: "project-one",
			issue: {
				workspaceSlug: "acme",
				issueIdentifier: "MUL-1",
				title: "Fix login",
				description: "Description",
				url: "https://multica.example.com/acme/issues/MUL-1",
			},
		});
	});

	it("normalizes the delivered issue reference", async () => {
		const t = setup();
		t.host.evaluateInPage.mockResolvedValueOnce(
			JSON.stringify({ ok: true, workspaceSlug: "ACME", issueIdentifier: "mul-1", title: "Fix login", description: "Description" }),
		);
		t.service.request();
		await flushPromises();

		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, {
			ok: true,
			issue: {
				workspaceSlug: "acme",
				issueIdentifier: "MUL-1",
				title: "Fix login",
				description: "Description",
				url: "https://multica.example.com/acme/issues/MUL-1",
			},
		});
	});

	it.each([
		["long identifier", { workspaceSlug: "acme", issueIdentifier: "MUL-" + "1".repeat(20000) }],
		["slash in identifier", { workspaceSlug: "acme", issueIdentifier: "MUL/1" }],
		["space in identifier", { workspaceSlug: "acme", issueIdentifier: "MUL 1" }],
		["empty slug", { workspaceSlug: "", issueIdentifier: "MUL-1" }],
	])("delivers unreadable for a %s", async (_name, reference) => {
		const t = setup();
		t.host.evaluateInPage.mockResolvedValueOnce(
			JSON.stringify({ ok: true, ...reference, title: "Fix login", description: "Description" }),
		);
		t.service.request();
		await flushPromises();

		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, { ok: false, reason: "unreadable" });
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("bounds delivered text by code points without splitting emoji", async () => {
		const t = setup();
		const description = `${"x".repeat(49999)}😀${"y".repeat(149999)}`;
		t.host.evaluateInPage.mockResolvedValueOnce(
			JSON.stringify({
				ok: true,
				workspaceSlug: "acme",
				issueIdentifier: "MUL-1",
				title: "😀".repeat(10000),
				description,
			}),
		);
		t.service.request();
		await flushPromises();

		const sentRequest = t.shell.send.mock.calls[0][1] as {
			ok: boolean;
			issue: { title: string; description: string };
		};
		expect(sentRequest.ok).toBe(true);
		expect(Array.from(sentRequest.issue.title)).toHaveLength(500);
		expect(Array.from(sentRequest.issue.description)).toHaveLength(50000);
		expect(sentRequest.issue.description.endsWith("😀")).toBe(true);
		expect(Array.from(sentRequest.issue.description).some((character) => character.length === 1 && /[\uD800-\uDFFF]/.test(character))).toBe(
			false,
		);
	});

	it("delivers signed_out from the page", async () => {
		const t = setup();
		t.host.evaluateInPage.mockResolvedValueOnce(JSON.stringify({ ok: false, reason: "signed_out" }));
		t.service.request();
		await flushPromises();

		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, { ok: false, reason: "signed_out" });
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("does not include the project id when a requested read fails", async () => {
		const t = setup();
		t.host.evaluateInPage.mockResolvedValueOnce(JSON.stringify({ ok: false, reason: "signed_out" }));
		t.service.request({ projectId: "project-one" });
		await flushPromises();

		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, {
			ok: false,
			reason: "signed_out",
		});
	});

	it.each([
		["no_workspace", JSON.stringify({ ok: false, reason: "no_workspace" })],
		["unreadable", JSON.stringify({ ok: false, reason: "unreadable" })],
		["malformed", undefined],
	] as const)("maps %s to unreadable", async (_name, result) => {
		const t = setup();
		t.host.evaluateInPage.mockResolvedValueOnce(result);
		t.service.request();
		await flushPromises();

		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, { ok: false, reason: "unreadable" });
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("maps a rejected page read to unreadable", async () => {
		const t = setup();
		t.host.evaluateInPage.mockRejectedValueOnce(new Error("page failed"));
		t.service.request();
		await flushPromises();

		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, { ok: false, reason: "unreadable" });
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("maps a read timeout to unreadable", async () => {
		vi.useFakeTimers();
		const t = setup();
		t.host.evaluateInPage.mockImplementationOnce(() => new Promise<unknown>(() => undefined));
		t.service.request();
		await flushPromises();
		await vi.advanceTimersByTimeAsync(READ_ISSUE_TIMEOUT_MS + 2000);
		await flushPromises();

		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, { ok: false, reason: "unreadable" });
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("reports unreadable when the view host is missing", async () => {
		const t = setup();
		t.setHost(undefined);
		t.service.request();
		await flushPromises();

		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, { ok: false, reason: "unreadable" });
		expect(t.host.evaluateInPage).not.toHaveBeenCalled();
		expect(t.host.setActive).not.toHaveBeenCalled();
	});

	it("reports no_issue without reading the page", async () => {
		const t = setup({ getCurrentIssue: () => null });
		t.service.request();
		await flushPromises();

		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, { ok: false, reason: "no_issue" });
		expect(t.host.evaluateInPage).not.toHaveBeenCalled();
	});

	it("reports unreadable when the Multica view has no server", async () => {
		const t = setup({}, { mode: "local", customUrl: "", apiUrl: "" });
		t.service.request();
		await flushPromises();

		expect(t.shell.send).toHaveBeenCalledExactlyOnceWith(MULTICA_SEND_REQUEST_CHANNEL, { ok: false, reason: "unreadable" });
		expect(t.host.evaluateInPage).not.toHaveBeenCalled();
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("ignores overlapping requests and accepts another after completion", async () => {
		const pending = deferred<unknown>();
		const t = setup();
		t.host.evaluateInPage.mockImplementationOnce(() => pending.promise);
		t.service.request({ projectId: "project-one" });
		await flushPromises();
		t.service.request({ projectId: "project-two" });
		expect(t.host.evaluateInPage).toHaveBeenCalledOnce();

		pending.resolve(successfulRead);
		await flushPromises();
		t.service.request();
		await flushPromises();

		expect(t.host.evaluateInPage).toHaveBeenCalledTimes(2);
		expect(t.shell.send).toHaveBeenCalledTimes(2);
		expect(t.shell.send.mock.calls[0][1]).toMatchObject({ projectId: "project-one" });
		expect(t.shell.send.mock.calls[1][1]).not.toHaveProperty("projectId");
	});

	it("does not send to a destroyed shell", async () => {
		const t = setup();
		t.shell.isDestroyed.mockReturnValue(true);

		expect(() => t.service.request()).not.toThrow();
		await flushPromises();

		expect(t.shell.send).not.toHaveBeenCalled();
		expect(t.host.setActive).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("drops a read that finishes after dispose and ignores later requests", async () => {
		const pending = deferred<unknown>();
		const t = setup();
		t.host.evaluateInPage.mockImplementationOnce(() => pending.promise);
		t.service.request();
		await flushPromises();
		t.service.dispose();
		pending.resolve(successfulRead);
		await flushPromises();
		t.service.request();
		await flushPromises();

		expect(t.host.evaluateInPage).toHaveBeenCalledOnce();
		expect(t.shell.send).not.toHaveBeenCalled();
		expect(t.host.setActive).not.toHaveBeenCalled();
	});
});
