import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MainProcessDelegationAuthority } from "./multica-delegation-authority";
import type { DelegationJournal, DelegationRecord } from "./multica-delegation-coordinator";

async function responseText(response: Response): Promise<string> {
	if (!response.body) throw new Error("journal_unavailable");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = []; let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read(); if (done) break;
			size += value.byteLength; if (size > 128 * 1024) throw new Error("journal_unavailable");
			chunks.push(value);
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export function createDaemonDelegationJournal(origin: () => string | null, authority: MainProcessDelegationAuthority, fetcher: typeof fetch = fetch): DelegationJournal {
	async function request(operation: string, body: object): Promise<DelegationRecord | null> {
		const base = origin();
		if (!base) throw new Error("journal_unavailable");
		const parsed = new URL(base);
		if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("invalid_journal_origin");
		const serialized = JSON.stringify({ operation, requestNonce: randomUUID(), ...body });
		const requestMAC = authority.requestMAC(serialized);
		const response = await fetcher(`${parsed.origin}/internal/multica-delegation-journal`, {
			method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(5000),
			headers: { "content-type": "application/json", "X-AO-Delegation-MAC": requestMAC }, body: serialized,
		});
		if (!response.ok) throw new Error(response.status === 409 ? "journal_conflict" : "journal_unavailable");
		const responseBody = await responseText(response);
		if (!authority.verifyResponseMAC(responseBody, requestMAC, response.headers.get("X-AO-Delegation-Response-MAC"))) throw new Error("journal_unavailable");
		const value: unknown = JSON.parse(responseBody);
		if (!value || typeof value !== "object" || !("record" in value)) throw new Error("journal_unavailable");
		const record = value.record;
		if (record === null) return null;
		if (!record || typeof record !== "object" || !("requestId" in record) || !("version" in record) || typeof record.requestId !== "string" || !Number.isSafeInteger(record.version)) throw new Error("journal_unavailable");
		return record as DelegationRecord;
	}
	async function write(operation: string, record: DelegationRecord, confirmationProof?: string) {
		const saved = await request(operation, { record, ...(confirmationProof ? { confirmationProof } : {}) });
		if (!saved || saved.projectId !== record.projectId || saved.taskId !== record.taskId || saved.payloadHash !== record.payloadHash || !isDeepStrictEqual(saved.intent, record.intent)) throw new Error("journal_unavailable");
		if (operation === "save" && !isDeepStrictEqual(saved, { ...record, version: record.version + 1 })) throw new Error("journal_unavailable");
		return saved;
	}
	return {
		get: async (requestId) => {
			const record = await request("get", { requestId });
			if (record && record.requestId !== requestId) throw new Error("journal_unavailable");
			return record;
		},
		find: async (projectId, taskId) => {
			const record = await request("find", { projectId, taskId });
			if (record && (record.projectId !== projectId || record.taskId !== taskId)) throw new Error("journal_unavailable");
			return record;
		},
		reserve: (record, proof) => write("reserve", record, proof),
		save: (record) => write("save", record),
	};
}
