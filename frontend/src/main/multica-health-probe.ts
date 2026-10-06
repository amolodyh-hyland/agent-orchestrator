import { get as httpGet, type ClientRequest } from "node:http";
import type { MulticaHealthPayload } from "./multica-daemon-guard";

export const MULTICA_HEALTH_RESPONSE_MAX_BYTES = 256 * 1024;

export function probeMulticaHealth(port: number, timeoutMs: number): Promise<MulticaHealthPayload | null> {
	return new Promise((resolve) => {
		let settled = false;
		let request: ClientRequest | undefined;
		const finish = (payload: MulticaHealthPayload | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			resolve(payload);
		};
		const deadline = setTimeout(() => {
			request?.destroy();
			finish(null);
		}, Math.max(0, timeoutMs));

		try {
			request = httpGet({ host: "127.0.0.1", port, path: "/health" }, (response) => {
				if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
					response.destroy();
					request?.destroy();
					finish(null);
					return;
				}

				let bodyBytes = 0;
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer | string) => {
					if (settled) return;
					const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					bodyBytes += bytes.length;
					if (bodyBytes > MULTICA_HEALTH_RESPONSE_MAX_BYTES) {
						response.destroy();
						request?.destroy();
						finish(null);
						return;
					}
					chunks.push(bytes);
				});
				response.on("end", () => {
					if (settled) return;
					try {
						const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						finish(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as MulticaHealthPayload) : null);
					} catch {
						finish(null);
					}
				});
				response.on("aborted", () => finish(null));
				response.on("error", () => finish(null));
				response.on("close", () => {
					if (!response.complete) finish(null);
				});
			});
			request.on("error", () => finish(null));
		} catch {
			finish(null);
		}
	});
}
