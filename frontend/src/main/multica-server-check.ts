import {
	multicaRuntimeConfig,
	validateMulticaServerUrl,
	type MulticaCheckResult,
	type MulticaServerCheckError,
	type MulticaSetSettingsRequest,
} from "../shared/multica";

const CHECK_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;

export type MulticaCheckResponse = { status: number; body: string };
/** One GET with no redirects followed and a capped body; rejects with the transport error. */
export type MulticaCheckGet = (url: string, signal: AbortSignal) => Promise<MulticaCheckResponse>;

/** Maps a transport error to a check error without ever echoing the URL or message to the user. */
export function classifyMulticaFetchError(error: unknown): MulticaServerCheckError {
	if (error instanceof Error && error.name === "AbortError") return "timeout";
	const text = `${error instanceof Error ? error.message : ""} ${(error as { cause?: { message?: string; code?: string } } | null)?.cause?.message ?? ""} ${(error as { cause?: { code?: string } } | null)?.cause?.code ?? ""}`;
	if (/ERR_CERT|ERR_SSL|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|certificate/i.test(text)) return "tls";
	if (/TIMED_OUT|ETIMEDOUT/i.test(text)) return "timeout";
	return "unreachable";
}

/** Multica's public /api/config carries these booleans; a random web server on the same port does not. */
function looksLikeMulticaConfig(body: string): boolean {
	try {
		const parsed: unknown = JSON.parse(body);
		return (
			!!parsed &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			typeof (parsed as Record<string, unknown>).allow_signup === "boolean"
		);
	} catch {
		return false;
	}
}

async function probe(get: MulticaCheckGet, url: string): Promise<MulticaServerCheckError | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
	try {
		const response = await get(url, controller.signal);
		if (response.status !== 200 || !looksLikeMulticaConfig(response.body)) return "not_multica";
		return null;
	} catch (error) {
		return classifyMulticaFetchError(error);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Checks that a self-hosted Multica answers. Tries the explicit API origin, or
 * the derived one and then the web origin itself (a reverse proxy serving /api
 * on the web origin), and returns the first that serves Multica's /api/config.
 * The error of the first candidate is reported when none does. A 503 from
 * /healthz on the API origin means the server is up but its database or
 * migrations are not ready.
 */
export async function checkMulticaServer(
	request: Pick<MulticaSetSettingsRequest, "customUrl" | "apiUrl">,
	get: MulticaCheckGet,
): Promise<MulticaCheckResult> {
	const web = validateMulticaServerUrl(request.customUrl);
	if (!web.ok) return { ok: false, error: web.error };
	let candidates: string[];
	if (request.apiUrl) {
		const api = validateMulticaServerUrl(request.apiUrl);
		if (!api.ok) return { ok: false, error: api.error };
		candidates = [api.origin];
	} else {
		const derived = multicaRuntimeConfig(web.origin);
		candidates = derived.ok ? [derived.config.apiUrl, web.origin] : [web.origin];
	}
	candidates = [...new Set(candidates)];

	let firstError: MulticaServerCheckError | null = null;
	for (const candidate of candidates) {
		const error = await probe(get, `${candidate}/api/config`);
		if (!error) {
			if (await isNotReady(get, candidate)) return { ok: false, error: "not_ready" };
			return { ok: true, apiUrl: candidate };
		}
		firstError ??= error;
	}
	return { ok: false, error: firstError ?? "unreachable" };
}

async function isNotReady(get: MulticaCheckGet, apiOrigin: string): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
	try {
		return (await get(`${apiOrigin}/healthz`, controller.signal)).status === 503;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** The production GET: Electron's network stack (system trust store), no redirects, capped body. */
export function createMulticaCheckGet(fetchImpl: (url: string, init: { signal: AbortSignal; redirect: "manual"; credentials: "omit" }) => Promise<Response>): MulticaCheckGet {
	return async (url, signal) => {
		const response = await fetchImpl(url, { signal, redirect: "manual", credentials: "omit" });
		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		if (reader) {
			while (size < MAX_BODY_BYTES) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
				size += value.byteLength;
			}
			void reader.cancel().catch(() => undefined);
		}
		const body = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, MAX_BODY_BYTES));
		return { status: response.status, body };
	};
}
