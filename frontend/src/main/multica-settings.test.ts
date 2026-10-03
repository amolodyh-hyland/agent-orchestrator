// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MULTICA_DEFAULT_URL } from "../shared/multica";
import { MULTICA_SETTINGS_FILE_NAME, readMulticaSettings, writeMulticaUrl } from "./multica-settings";

describe("multica settings", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-multica-settings-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	it("defaults to the local Multica web app when nothing is stored or the file is corrupt", async () => {
		expect(await readMulticaSettings(stateDir)).toEqual({ url: MULTICA_DEFAULT_URL });
		await writeFile(path.join(stateDir, MULTICA_SETTINGS_FILE_NAME), "{not json");
		expect(await readMulticaSettings(stateDir)).toEqual({ url: MULTICA_DEFAULT_URL });
	});

	it("persists a normalized URL under AO state", async () => {
		await writeMulticaUrl(stateDir, "multica.example.com:8443");
		expect(await readMulticaSettings(stateDir)).toEqual({ url: "http://multica.example.com:8443/" });
		const raw = await readFile(path.join(stateDir, MULTICA_SETTINGS_FILE_NAME), "utf8");
		expect(JSON.parse(raw)).toEqual({ url: "http://multica.example.com:8443/" });
	});

	it("keeps a cleared URL cleared across reads", async () => {
		await writeMulticaUrl(stateDir, "");
		expect(await readMulticaSettings(stateDir)).toEqual({ url: "" });
	});

	it("rejects an invalid URL without touching the stored value", async () => {
		await writeMulticaUrl(stateDir, "https://multica.example.com");
		await expect(writeMulticaUrl(stateDir, "ftp://example.com")).rejects.toThrow("Invalid Multica URL");
		expect(await readMulticaSettings(stateDir)).toEqual({ url: "https://multica.example.com/" });
	});

	it("treats a hand-edited invalid URL as unset", async () => {
		await writeFile(path.join(stateDir, MULTICA_SETTINGS_FILE_NAME), `{"url":"javascript:alert(1)"}`);
		expect(await readMulticaSettings(stateDir)).toEqual({ url: "" });
	});
});
