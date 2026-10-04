export const READ_ISSUE_TIMEOUT_MS = 6000;
export type ReadIssueFailure = "signed_out" | "no_workspace" | "unreadable";
export type ReadIssueResult =
	| { ok: true; workspaceSlug: string; issueIdentifier: string; title: string; description: string }
	| { ok: false; reason: ReadIssueFailure };

export function buildReadIssueScript(input: { apiUrl: string; identifier: string }): string {
	return `(async () => {
	try {
		const apiUrl = ${JSON.stringify(input.apiUrl)};
		const identifier = ${JSON.stringify(input.identifier)};
		const token = localStorage.getItem("multica_token");
		if (!token) return JSON.stringify({ ok: false, reason: "signed_out" });
		let slug;
		try {
			slug = JSON.parse(localStorage.getItem("multica_tabs") || "null")?.state?.activeWorkspaceSlug;
		} catch {
			return JSON.stringify({ ok: false, reason: "no_workspace" });
		}
		if (typeof slug !== "string" || slug.length === 0) return JSON.stringify({ ok: false, reason: "no_workspace" });
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), ${READ_ISSUE_TIMEOUT_MS});
		try {
			const response = await fetch(apiUrl.replace(/\\/+$/, "") + "/api/issues/" + encodeURIComponent(identifier), {
				method: "GET",
				headers: { Authorization: "Bearer " + token, "X-Workspace-Slug": slug },
				credentials: "omit",
				signal: controller.signal,
			});
			if (response.status === 401) return JSON.stringify({ ok: false, reason: "signed_out" });
			if (!response.ok) return JSON.stringify({ ok: false, reason: "unreadable" });
			const data = await response.json();
			if (!data || typeof data.identifier !== "string" || typeof data.title !== "string") {
				return JSON.stringify({ ok: false, reason: "unreadable" });
			}
			if (data.description !== null && data.description !== undefined && typeof data.description !== "string") {
				return JSON.stringify({ ok: false, reason: "unreadable" });
			}
			const description = data.description ?? "";
			return JSON.stringify({ ok: true, workspaceSlug: slug, issueIdentifier: data.identifier, title: data.title, description });
		} finally {
			clearTimeout(timeout);
		}
	} catch {
		return JSON.stringify({ ok: false, reason: "unreadable" });
	}
})()`;
}

export function parseReadIssueResult(raw: unknown): ReadIssueResult {
	if (typeof raw !== "string") return { ok: false, reason: "unreadable" };
	try {
		const result: unknown = JSON.parse(raw);
		if (!result || typeof result !== "object" || Array.isArray(result)) return { ok: false, reason: "unreadable" };
		const value = result as Record<string, unknown>;
		if (value.ok === false && ["signed_out", "no_workspace", "unreadable"].includes(value.reason as string)) {
			return { ok: false, reason: value.reason as ReadIssueFailure };
		}
		if (
			value.ok === true &&
			typeof value.workspaceSlug === "string" &&
			typeof value.issueIdentifier === "string" &&
			typeof value.title === "string" &&
			typeof value.description === "string"
		) {
			return {
				ok: true,
				workspaceSlug: value.workspaceSlug,
				issueIdentifier: value.issueIdentifier,
				title: value.title,
				description: value.description,
			};
		}
	} catch {
		return { ok: false, reason: "unreadable" };
	}
	return { ok: false, reason: "unreadable" };
}
