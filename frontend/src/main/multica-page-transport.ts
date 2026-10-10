// Page-only mode: reads go through the embedded Multica page, which already
// holds the user's sign-in. AO stores and sees no token. The script that runs in
// the page is built from the same allow-list as the token client, is bound to
// the server's API origin, and returns only a status and a body.

import {
	MAX_RESPONSE_BYTES,
	READ_TIMEOUT_MS,
	TransportError,
	isAllowedReadRequest,
	parseRetryAfter,
	type RawResponse,
	type ReadRequest,
	type ReadTransport,
} from "./multica-read-client";

export function buildPageReadScript(input: { apiOrigin: string; request: ReadRequest }): string {
	const { apiOrigin, request } = input;
	if (!isAllowedReadRequest(request)) throw new Error("request is not on the read allow-list");
	const origin = new URL(apiOrigin).origin;
	const url = new URL(`${request.path}${request.query}`, origin);
	if (url.origin !== origin || url.pathname !== request.path) throw new Error("request does not stay on the server origin");
	const workspaceHeader = request.workspace === null ? null : "id" in request.workspace ? ["X-Workspace-ID", request.workspace.id] : ["X-Workspace-Slug", request.workspace.slug];
	return `(async () => {
	try {
		const token = localStorage.getItem("multica_token");
		if (!token) return JSON.stringify({ status: 401, body: "" });
		const headers = { Accept: "application/json", Authorization: "Bearer " + token };
		const workspaceHeader = ${JSON.stringify(workspaceHeader)};
		if (workspaceHeader) headers[workspaceHeader[0]] = workspaceHeader[1];
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), ${READ_TIMEOUT_MS});
		try {
			const response = await fetch(${JSON.stringify(url.href)}, {
				method: "GET",
				headers,
				credentials: "omit",
				redirect: "manual",
				signal: controller.signal,
			});
			if (response.status >= 300 && response.status < 400) return JSON.stringify({ status: 0, body: "", redirect: true });
			const body = await response.text();
			return JSON.stringify({ status: response.status, body: body.length > ${MAX_RESPONSE_BYTES} ? "" : body, retryAfter: response.headers.get("retry-after") });
		} finally {
			clearTimeout(timeout);
		}
	} catch {
		return JSON.stringify({ status: 0, body: "" });
	}
})()`;
}

/** Parses what the page script returned. Anything unexpected is a failed read. */
export function parsePageReadResult(raw: unknown, nowMs: number): RawResponse {
	if (typeof raw !== "string") throw new TransportError("unreachable");
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new TransportError("unreachable");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TransportError("unreachable");
	const record = value as Record<string, unknown>;
	if (record.redirect === true) throw new TransportError("redirect");
	if (typeof record.status !== "number" || !Number.isInteger(record.status) || typeof record.body !== "string") throw new TransportError("unreachable");
	if (record.status === 0) throw new TransportError("unreachable");
	const retryAfterMs = parseRetryAfter(typeof record.retryAfter === "string" ? record.retryAfter : null, nowMs);
	return { status: record.status, body: record.body, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

export type PageHost = {
	/** Runs `script` in the Multica page of `serverKey`; undefined when the view is absent or shows another server. */
	evaluateInPage: (script: string, serverKey?: string) => Promise<unknown>;
};

export function createPageTransport(options: { host: () => PageHost | undefined; serverKey: string; apiOrigin: string; now?: () => number }): ReadTransport {
	const now = options.now ?? (() => Date.now());
	return async (request): Promise<RawResponse> => {
		const script = buildPageReadScript({ apiOrigin: options.apiOrigin, request });
		const host = options.host();
		if (!host) throw new TransportError("unreachable");
		const result = await host.evaluateInPage(script, options.serverKey);
		return parsePageReadResult(result, now());
	};
}
