import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
	MULTICA_ACTION_READ_MAX,
	buildActionRecord,
	parseActionRecord,
	type MulticaActionInput,
	type MulticaActionLogQuery,
	type MulticaActionRecord,
} from "../shared/multica-action-log";

export const MULTICA_ACTION_LOG_FILE = "multica-action-log.jsonl";
export const MULTICA_ACTION_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** The live file plus four rotated ones: about 25 MB at most. */
export const MULTICA_ACTION_LOG_MAX_FILES = 5;

/** Connection lifecycle kinds: one line per state change, so an identical repeat in the same scope is dropped. */
const LIFECYCLE_KINDS = new Set(["connect", "disconnect", "signed_out", "error"]);

export type MulticaActionLogOptions = {
	maxBytes?: number;
	maxFiles?: number;
	now?: () => Date;
	createId?: () => string;
};

export type MulticaActionLog = {
	/**
	 * Appends one record for a cross-system action or decision. Resolves when the
	 * line is on disk; never rejects, because an audit failure must not break the
	 * action it describes. P0's write path calls this after each write attempt.
	 */
	record: (input: MulticaActionInput) => Promise<void>;
	/** Newest first, across the live and rotated files. */
	read: (query?: MulticaActionLogQuery) => Promise<MulticaActionRecord[]>;
};

function rotatedName(file: string, index: number): string {
	return index === 0 ? file : `${file}.${index}`;
}

export function createMulticaActionLog(stateDir: string, options: MulticaActionLogOptions = {}): MulticaActionLog {
	const maxBytes = options.maxBytes ?? MULTICA_ACTION_LOG_MAX_BYTES;
	const maxFiles = Math.max(1, options.maxFiles ?? MULTICA_ACTION_LOG_MAX_FILES);
	const now = options.now ?? (() => new Date());
	const createId = options.createId ?? randomUUID;
	const file = path.join(stateDir, MULTICA_ACTION_LOG_FILE);
	let queue: Promise<void> = Promise.resolve();
	let size: number | null = null;
	const lastLifecycle = new Map<string, string>();

	const run = (operation: () => Promise<void>): Promise<void> => {
		const queued = queue.then(operation, operation);
		queue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	};

	async function currentSize(): Promise<number> {
		if (size !== null) return size;
		try {
			size = (await stat(file)).size;
		} catch {
			size = 0;
		}
		return size;
	}

	async function rotate(): Promise<void> {
		await unlink(rotatedName(file, maxFiles - 1)).catch(() => undefined);
		for (let index = maxFiles - 2; index >= 0; index -= 1) {
			await rename(rotatedName(file, index), rotatedName(file, index + 1)).catch(() => undefined);
		}
		size = 0;
	}

	const isRepeat = (record: MulticaActionRecord): boolean => {
		if (!LIFECYCLE_KINDS.has(record.kind)) return false;
		const scope = `${record.serverKey ?? ""}|${record.workspaceId ?? ""}`;
		const signature = `${record.kind}|${record.result?.code ?? ""}|${record.result?.ok ?? ""}`;
		if (lastLifecycle.get(scope) === signature) return true;
		lastLifecycle.set(scope, signature);
		return false;
	};

	return {
		record: (input) =>
			run(async () => {
				try {
					const record = buildActionRecord(input, createId(), now());
					if (isRepeat(record)) return;
					const line = `${JSON.stringify(record)}\n`;
					await mkdir(stateDir, { recursive: true, mode: 0o750 });
					const bytes = Buffer.byteLength(line);
					if ((await currentSize()) > 0 && (await currentSize()) + bytes > maxBytes) await rotate();
					await appendFile(file, line, { mode: 0o600 });
					await chmod(file, 0o600).catch(() => undefined);
					size = (size ?? 0) + bytes;
				} catch {
					// The log is best effort: a full disk or a permission error must not break the action.
				}
			}),
		read: async (query = {}) => {
			await queue;
			const limit = Math.min(query.limit ?? MULTICA_ACTION_READ_MAX, MULTICA_ACTION_READ_MAX);
			const records: MulticaActionRecord[] = [];
			for (let index = 0; index < maxFiles && records.length < limit; index += 1) {
				let raw: string;
				try {
					raw = await readFile(rotatedName(file, index), "utf8");
				} catch {
					continue;
				}
				const lines = raw.split("\n");
				for (let lineIndex = lines.length - 1; lineIndex >= 0 && records.length < limit; lineIndex -= 1) {
					const record = parseActionRecord(lines[lineIndex]);
					if (!record) continue;
					if (query.issueId !== undefined && record.issueId !== query.issueId) continue;
					if (query.kind !== undefined && record.kind !== query.kind) continue;
					records.push(record);
				}
			}
			return records;
		},
	};
}

const sharedLogs = new Map<string, MulticaActionLog>();

/**
 * The one action log of a state directory. The size count and the write queue
 * live in the instance, so every writer in the process (awareness, the status
 * write) must share it: two instances on one directory would race rotation and
 * appends. The first call fixes the options.
 */
export function getMulticaActionLog(stateDir: string, options: MulticaActionLogOptions = {}): MulticaActionLog {
	const key = path.resolve(stateDir);
	let log = sharedLogs.get(key);
	if (!log) {
		log = createMulticaActionLog(stateDir, options);
		sharedLogs.set(key, log);
	}
	return log;
}
