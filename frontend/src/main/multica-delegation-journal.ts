import { isDeepStrictEqual } from "node:util";
import type { DelegationJournal, DelegationRecord } from "./multica-delegation-coordinator";

export function createDaemonDelegationJournal(origin: () => string | null, fetcher: typeof fetch = fetch): DelegationJournal {
	async function request(operation: string, body: object): Promise<DelegationRecord | null> {
		const base = origin();
		if (!base) throw new Error("journal_unavailable");
		const parsed = new URL(base);
		if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("invalid_journal_origin");
		const response = await fetcher(`${parsed.origin}/internal/multica-delegation-journal`, {
			method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(5000),
			headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, ...body }),
		});
		if (!response.ok) throw new Error(response.status === 409 ? "journal_conflict" : "journal_unavailable");
		const value: unknown = await response.json();
		if (!value || typeof value !== "object" || !("record" in value)) throw new Error("journal_unavailable");
		const record = value.record;
		if (record === null) return null;
		if (!record || typeof record !== "object" || !("requestId" in record) || !("version" in record) || typeof record.requestId !== "string" || !Number.isSafeInteger(record.version)) throw new Error("journal_unavailable");
		return record as DelegationRecord;
	}
	async function write(operation: string, record: DelegationRecord) {
		const saved = await request(operation, { record });
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
		reserve: (record) => write("reserve", record),
		save: (record) => write("save", record),
	};
}
