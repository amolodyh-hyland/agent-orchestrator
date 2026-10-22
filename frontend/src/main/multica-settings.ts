import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { coerceMulticaSettings, DEFAULT_MULTICA_SETTINGS, parseMulticaUrl, type MulticaSettings } from "../shared/multica";

export const MULTICA_SETTINGS_FILE_NAME = "multica-settings.json";

let settingsOperationQueue: Promise<void> = Promise.resolve();

async function readUnlocked(stateDir: string): Promise<MulticaSettings> {
	try {
		const raw = await readFile(path.join(stateDir, MULTICA_SETTINGS_FILE_NAME), "utf8");
		return coerceMulticaSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_MULTICA_SETTINGS };
	}
}

async function writeUnlocked(stateDir: string, settings: MulticaSettings, delegationEnabled?: boolean): Promise<MulticaSettings> {
	const next = coerceMulticaSettings(settings);
	const enabled = delegationEnabled ?? await readMulticaDelegationEnabled(stateDir);
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	const file = path.join(stateDir, MULTICA_SETTINGS_FILE_NAME);
	const temporary = path.join(stateDir, `.multica-settings-${process.pid}-${Date.now()}.json`);
	await writeFile(temporary, `${JSON.stringify({ version: 2, ...next, delegationEnabled: enabled === true }, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, file);
	return next;
}

function runSettingsOperation<T>(operation: () => Promise<T>): Promise<T> {
	const queued = settingsOperationQueue.then(operation, operation);
	settingsOperationQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	return queued;
}

export function readMulticaSettings(stateDir: string): Promise<MulticaSettings> {
	return readUnlocked(stateDir);
}

export async function readMulticaDelegationEnabled(stateDir: string): Promise<boolean> {
	try {
		const value: unknown = JSON.parse(await readFile(path.join(stateDir, MULTICA_SETTINGS_FILE_NAME), "utf8"));
		return !!value && typeof value === "object" && !Array.isArray(value) && "version" in value && value.version === 2 && "delegationEnabled" in value && value.delegationEnabled === true;
	} catch { return false; }
}

export function writeMulticaDelegationEnabled(stateDir: string, enabled: boolean): Promise<void> {
	return runSettingsOperation(async () => { await writeUnlocked(stateDir, await readUnlocked(stateDir), enabled === true); });
}

/** Persists the settings. A non-empty URL must at least be a valid http(s) URL; the caller applies the stricter server rules. */
export function writeMulticaSettings(stateDir: string, settings: MulticaSettings): Promise<MulticaSettings> {
	for (const url of [settings.customUrl, settings.apiUrl]) {
		if (url.trim() !== "" && !parseMulticaUrl(url).ok) return Promise.reject(new Error("Invalid Multica URL"));
	}
	return runSettingsOperation(() => writeUnlocked(stateDir, settings));
}
