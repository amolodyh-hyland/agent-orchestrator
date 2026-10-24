import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubDaemonError, isGitHubAuthInvalidError, listGitHubRepos, saveGitHubPAT } from "./github-daemon";

vi.mock("./api-client", () => ({
	getApiBaseUrl: () => "http://127.0.0.1:3002",
	fetchDesktopDaemon: (input: Request) => fetch(input),
}));

describe("GitHub daemon client", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves the status and stable code for a revoked credential", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
			code: "GITHUB_AUTH_INVALID",
			message: "GitHub authorization expired. Reconnect GitHub to continue.",
		}), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		}));

		const error = await listGitHubRepos().catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(GitHubDaemonError);
		expect(error).toMatchObject({ status: 401, code: "GITHUB_AUTH_INVALID" });
		expect(isGitHubAuthInvalidError(error)).toBe(true);
	});

	it("sends credential writes through the shared desktop daemon request path", async () => {
		const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "ok" }));
		await saveGitHubPAT("synthetic-test-token");
		const request = send.mock.calls[0][0] as Request;
		expect(request).toBeInstanceOf(Request);
		expect(request.method).toBe("PUT");
		expect(await request.json()).toEqual({ pat: "synthetic-test-token" });
	});
});
