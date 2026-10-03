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

async function writeUnlocked(stateDir: string, url: string): Promise<MulticaSettings> {
	const next = coerceMulticaSettings({ url });
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	const file = path.join(stateDir, MULTICA_SETTINGS_FILE_NAME);
	const temporary = path.join(stateDir, `.multica-settings-${process.pid}-${Date.now()}.json`);
	await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
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

/** Persists the URL. An empty string clears it; anything else must be a valid http(s) URL. */
export function writeMulticaUrl(stateDir: string, url: string): Promise<MulticaSettings> {
	if (url.trim() !== "" && !parseMulticaUrl(url).ok) {
		return Promise.reject(new Error("Invalid Multica URL"));
	}
	return runSettingsOperation(() => writeUnlocked(stateDir, url));
}
