import type { WebContents } from "electron";
import { multicaIssuePath, parseMulticaIssueRef } from "../shared/multica-issue-links";
import {
	MULTICA_SEND_REQUEST_CHANNEL,
	multicaIssueWebUrl,
	type MulticaSendRequest,
} from "../shared/multica-send-to-ao";
import { buildReadIssueScript, parseReadIssueResult, READ_ISSUE_TIMEOUT_MS } from "./multica-issue-reader";
import type { MulticaViewHost } from "./multica-view-host";

export type MulticaSendToAoOptions = {
	shellWebContents: Pick<WebContents, "isDestroyed" | "send">;
	getHost: () => Pick<MulticaViewHost, "evaluateInPage" | "getServer" | "setActive"> | undefined;
	getCurrentIssue: () => { identifier: string; title: string } | null;
};

export type MulticaSendToAo = { request: (options?: { projectId?: string }) => void; dispose: () => void };

export function createMulticaSendToAo(options: MulticaSendToAoOptions): MulticaSendToAo {
	let disposed = false;
	let inFlight = false;

	const deliver = (request: MulticaSendRequest): void => {
		if (disposed) return;
		try {
			options.getHost()?.setActive(false);
		} catch {
			// The view can disappear while the request is being delivered.
		}
		try {
			if (!options.shellWebContents.isDestroyed()) {
				options.shellWebContents.send(MULTICA_SEND_REQUEST_CHANNEL, request);
			}
		} catch {
			// The shell can close while the request is being delivered.
		}
	};

	const requestIssue = async (projectId?: string): Promise<void> => {
		try {
			const issue = options.getCurrentIssue();
			if (!issue) {
				deliver({ ok: false, reason: "no_issue" });
				return;
			}

			const host = options.getHost();
			// The server comes from the live view itself and the script is bound to it,
			// so a switch while this runs cannot send one server's token to another's API.
			const server = host?.getServer();
			if (!host || !server) {
				deliver({ ok: false, reason: "unreadable" });
				return;
			}

			let timer: ReturnType<typeof setTimeout> | undefined;
			let raw: unknown;
			try {
				const timeout = new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), READ_ISSUE_TIMEOUT_MS + 2000);
				});
				raw = await Promise.race([
					host.evaluateInPage(buildReadIssueScript({ apiUrl: server.config.apiUrl, identifier: issue.identifier }), server.key),
					timeout,
				]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
			if (disposed) return;

			const result = parseReadIssueResult(raw);
			if (!result.ok) {
				deliver({ ok: false, reason: result.reason === "signed_out" ? "signed_out" : "unreadable" });
				return;
			}
			const issueRef = parseMulticaIssueRef(
				multicaIssuePath({ workspaceSlug: result.workspaceSlug, issueIdentifier: result.issueIdentifier }),
			);
			if (!issueRef) {
				deliver({ ok: false, reason: "unreadable" });
				return;
			}
			deliver({
				ok: true,
				...(projectId !== undefined ? { projectId } : {}),
				issue: {
					workspaceSlug: issueRef.workspaceSlug,
					issueIdentifier: issueRef.issueIdentifier,
					title: Array.from(result.title).slice(0, 500).join(""),
					description: Array.from(result.description).slice(0, 50000).join(""),
					url: multicaIssueWebUrl(server.config.appUrl, issueRef),
				},
			});
		} catch {
			deliver({ ok: false, reason: "unreadable" });
		} finally {
			inFlight = false;
		}
	};

	return {
		request: (requestOptions) => {
			if (disposed || inFlight) return;
			inFlight = true;
			void requestIssue(requestOptions?.projectId);
		},
		dispose: () => {
			disposed = true;
		},
	};
}
