import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./api-client";
import { useMulticaLinksStore } from "../stores/multica-links-store";
import { buildSendToAoPrompt, sendToAoDisplayName, type MulticaSendIssue } from "../../shared/multica-send-to-ao";
import { createMulticaIssueSession } from "./multica-send-to-ao";

const { postMock, addMock } = vi.hoisted(() => ({
	postMock: vi.fn(),
	addMock: vi.fn(),
}));

vi.mock("./api-client", () => ({
	apiClient: { POST: postMock },
	apiErrorMessage: (error: unknown, fallback = "Request failed") =>
		typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
			? error.message
			: fallback,
}));

vi.mock("../stores/multica-links-store", () => ({
	useMulticaLinksStore: { getState: () => ({ add: addMock }) },
}));

const issue: MulticaSendIssue = {
	workspaceSlug: "acme",
	issueIdentifier: "MUL-1",
	title: "MUL-1: Fix the widget",
	description: "Fix the widget behavior.",
	url: "https://multica.example/acme/issues/MUL-1",
};

const input = {
	issue,
	projectId: "project-1",
	fallbackMessage: "Could not create session",
};

describe("createMulticaIssueSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("creates a worker session and links it to the issue", async () => {
		const post = vi.fn().mockResolvedValue({ session: { id: "session-1", projectId: "project-2" } });
		const addLink = vi.fn().mockResolvedValue({ ok: true });

		const result = await createMulticaIssueSession(input, { post, addLink });

		expect(result).toEqual({ ok: true, sessionId: "session-1", projectId: "project-2", linked: true });
		const [body] = post.mock.calls[0] as [Record<string, unknown>];
		expect(body).toEqual({
			projectId: "project-1",
			kind: "worker",
			prompt: buildSendToAoPrompt(issue),
			displayName: sendToAoDisplayName(issue),
		});
		expect(Object.keys(body).sort()).toEqual(["displayName", "kind", "projectId", "prompt"]);
		expect(body).not.toHaveProperty("issueId");
		expect(addLink).toHaveBeenCalledOnce();
		expect(addLink).toHaveBeenCalledWith({ sessionId: "session-1", projectId: "project-2", issue: "acme/issues/MUL-1" });
	});

	it("includes only a non-empty harness", async () => {
		const post = vi.fn().mockResolvedValue({ session: { id: "session-1" } });
		const addLink = vi.fn().mockResolvedValue({ ok: true });

		await createMulticaIssueSession({ ...input, harness: "codex" }, { post, addLink });

		expect(post).toHaveBeenCalledWith({
			projectId: "project-1",
			kind: "worker",
			prompt: buildSendToAoPrompt(issue),
			displayName: sendToAoDisplayName(issue),
			harness: "codex",
		});
		await createMulticaIssueSession({ ...input, harness: "" }, { post, addLink });
		expect(post.mock.calls[1]?.[0]).not.toHaveProperty("harness");
	});

	it("returns success when adding the link fails or throws", async () => {
		const post = vi.fn().mockResolvedValue({ session: { id: "session-1" } });
		const addLink = vi.fn().mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error("save failed"));

		await expect(createMulticaIssueSession(input, { post, addLink })).resolves.toEqual({
			ok: true,
			sessionId: "session-1",
			projectId: "project-1",
			linked: false,
		});
		await expect(createMulticaIssueSession(input, { post, addLink })).resolves.toEqual({
			ok: true,
			sessionId: "session-1",
			projectId: "project-1",
			linked: false,
		});
	});

	it("returns API messages and does not link after an API error", async () => {
		const post = vi.fn().mockResolvedValue({ error: { message: "Daemon rejected the request" } });
		const addLink = vi.fn();

		await expect(createMulticaIssueSession(input, { post, addLink })).resolves.toEqual({
			ok: false,
			message: "Daemon rejected the request",
		});
		post.mockResolvedValueOnce({ error: { code: "SESSION_FAILED" } });
		await expect(createMulticaIssueSession(input, { post, addLink })).resolves.toEqual({
			ok: false,
			message: input.fallbackMessage,
		});
		expect(addLink).not.toHaveBeenCalled();
	});

	it("uses the fallback message when a successful response has no session id", async () => {
		const addLink = vi.fn();

		await expect(
			createMulticaIssueSession(input, { post: vi.fn().mockResolvedValue({ session: {} }), addLink }),
		).resolves.toEqual({ ok: false, message: input.fallbackMessage });
		expect(addLink).not.toHaveBeenCalled();
	});

	it("uses the API client and store defaults", async () => {
		postMock.mockResolvedValue({ data: { session: { id: "session-1", projectId: "project-3" } }, error: undefined });
		addMock.mockResolvedValue({ ok: true });

		await expect(createMulticaIssueSession({ ...input, harness: "codex" })).resolves.toEqual({
			ok: true,
			sessionId: "session-1",
			projectId: "project-3",
			linked: true,
		});
		expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/sessions", {
			body: {
				projectId: "project-1",
				kind: "worker",
				prompt: buildSendToAoPrompt(issue),
				displayName: sendToAoDisplayName(issue),
				harness: "codex",
			},
		});
		expect(useMulticaLinksStore.getState().add).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-3",
			issue: "acme/issues/MUL-1",
		});
	});
});
