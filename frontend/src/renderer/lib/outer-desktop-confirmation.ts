import {
	outerDesktopRequest,
	type OuterDesktopRequest,
} from "../../shared/outer-desktop";
import type { OuterResult } from "../../shared/outer-native";
import { aoBridge } from "./bridge";

type HTTPReceipt = { status: number; body: string };
export type DesktopConfirmation = {
	id: string;
	request: OuterDesktopRequest;
	finish(receipt?: HTTPReceipt): void;
};
const listeners = new Set<() => void>();
let pending: DesktopConfirmation[] = [];
const publish = () => {
	for (const listener of listeners) listener();
};

const privateField =
	/(?:^pat$|token|password|secret|api.?key|credential|base64)/i;
export function desktopConfirmationPreview(
	request: OuterDesktopRequest,
	mask: string
): string {
	const parameters = request.route.match(/\{[^}]+\}/g) ?? [];
	return JSON.stringify(
		{
			action: request.route,
			targets: request.parameters.map((value, i) =>
				privateField.test(parameters[i] ?? "") ? mask : value
			),
			...(request.query
				? {
						options: [...new URLSearchParams(request.query)].map(
							([key, value]) => [
								key,
								privateField.test(key) ? mask : value,
							]
						),
					}
				: {}),
			changes: request.payload,
		},
		(key, value: unknown) => (privateField.test(key) ? mask : value),
		2
	);
}
export const desktopConfirmations = () => pending;
export function subscribeDesktopConfirmations(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0)
			for (const entry of [...pending]) entry.finish();
	};
}

export function desktopControlReceipt(
	result: OuterResult
): HTTPReceipt | undefined {
	if (!result.ok || !result.record || typeof result.record !== "object")
		return undefined;
	const record = result.record as Partial<HTTPReceipt>;
	return Number.isInteger(record.status) &&
		record.status! >= 200 &&
		record.status! <= 599 &&
		typeof record.body === "string"
		? (record as HTTPReceipt)
		: undefined;
}

// Preserve an immutable request before fetch consumes its body. This is inert:
// neither a REST caller nor opening the confirmation can issue native authority.
export async function prepareDesktopConfirmation(
	input: Request
): Promise<OuterDesktopRequest | undefined> {
	if (
		!aoBridge.outer ||
		input.headers.has("X-AO-Scope-Credential") ||
		input.signal.aborted ||
		["GET", "HEAD", "OPTIONS"].includes(input.method)
	)
		return undefined;
	try {
		const reader = input.clone().body?.getReader();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let raw = "",
			size = 0;
		if (reader) {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > 96 << 10) return undefined;
					raw += decoder.decode(value, { stream: true });
				}
				raw += decoder.decode();
			} finally {
				void reader.cancel().catch(() => undefined);
				reader.releaseLock();
			}
		}
		return outerDesktopRequest(
			input.method,
			new URL(input.url),
			raw ? JSON.parse(raw) : null,
			input.headers.get("X-AO-Attachment-Upload") === "1"
		);
	} catch {
		return undefined;
	}
}

// Only the daemon's explicit OUTER_HELD response enters this path. Ordinary
// requests, remote hosts, unavailable native bridges and unsupported interfaces
// retain their original responses. There is no authenticated HTTP retry.
export async function confirmHeldDesktopRequest(
	request: OuterDesktopRequest | undefined,
	response: Response,
	signal: AbortSignal
): Promise<Response> {
	if (
		!request ||
		response.status !== 409 ||
		listeners.size === 0 ||
		pending.length >= 8 ||
		signal.aborted
	)
		return response;
	try {
		if ((await response.clone().json()).code !== "OUTER_HELD")
			return response;
	} catch {
		return response;
	}
	if (signal.aborted || listeners.size === 0) return response;
	return new Promise<Response>((resolve) => {
		let finished = false;
		const entry: DesktopConfirmation = {
			id: crypto.randomUUID(),
			request,
			finish(receipt) {
				if (finished) return;
				finished = true;
				clearTimeout(expiry);
				signal.removeEventListener("abort", cancel);
				pending = pending.filter((item) => item !== entry);
				publish();
				resolve(
					receipt
						? new Response(
								[204, 205, 304].includes(receipt.status)
									? null
									: receipt.body || null,
								{
									status: receipt.status,
									headers: {
										"Content-Type": "application/json",
									},
								}
							)
						: new Response(
								JSON.stringify({
									code: "OUTER_CONFIRMATION_CLOSED",
									message:
										"Action held or delivery uncertain. Inspect the current state before making another request.",
								}),
								{
									status: 409,
									headers: {
										"Content-Type": "application/json",
									},
								}
							)
				);
			},
		};
		const cancel = () => entry.finish();
		const expiry = setTimeout(cancel, 120_000);
		signal.addEventListener("abort", cancel, { once: true });
		pending = [...pending, entry];
		publish();
	});
}
