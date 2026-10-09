// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MULTICA_SETTINGS } from "../shared/multica";
import { MULTICA_SETTINGS_FILE_NAME, readMulticaSettings, writeMulticaSettings } from "./multica-settings";

describe("multica settings", () => {
	let stateDir: string;
	const file = () => path.join(stateDir, MULTICA_SETTINGS_FILE_NAME);

	beforeEach(async () => {
		stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-multica-settings-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	it("defaults to the local Multica web app when nothing is stored or the file is corrupt", async () => {
		expect(await readMulticaSettings(stateDir)).toEqual(DEFAULT_MULTICA_SETTINGS);
		await writeFile(file(), "{not json");
		expect(await readMulticaSettings(stateDir)).toEqual(DEFAULT_MULTICA_SETTINGS);
	});

	it("persists mode, custom URL and API URL as a version 2 file, readable only by the user", async () => {
		await writeMulticaSettings(stateDir, { mode: "local", customUrl: "https://multica.example.com", apiUrl: "https://multica.example.com" });
		expect(await readMulticaSettings(stateDir)).toEqual({
			mode: "local",
			customUrl: "https://multica.example.com",
			apiUrl: "https://multica.example.com",
		});
		expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({
			version: 2,
			mode: "local",
			customUrl: "https://multica.example.com",
			apiUrl: "https://multica.example.com",
		});
		if (process.platform !== "win32") expect((await stat(file())).mode & 0o777).toBe(0o600);
	});

	it("keeps the custom URL while the mode is cloud", async () => {
		await writeMulticaSettings(stateDir, { mode: "cloud", customUrl: "http://192.168.1.5:3000", apiUrl: "" });
		expect(await readMulticaSettings(stateDir)).toEqual({ mode: "cloud", customUrl: "http://192.168.1.5:3000", apiUrl: "" });
	});

	it("keeps a cleared URL cleared across reads", async () => {
		await writeMulticaSettings(stateDir, { mode: "local", customUrl: "", apiUrl: "" });
		expect(await readMulticaSettings(stateDir)).toEqual({ mode: "local", customUrl: "", apiUrl: "" });
	});

	it("rejects an invalid URL without touching the stored value", async () => {
		await writeMulticaSettings(stateDir, { mode: "local", customUrl: "https://multica.example.com", apiUrl: "" });
		await expect(writeMulticaSettings(stateDir, { mode: "local", customUrl: "ftp://example.com", apiUrl: "" })).rejects.toThrow(
			"Invalid Multica URL",
		);
		await expect(
			writeMulticaSettings(stateDir, { mode: "local", customUrl: "https://multica.example.com", apiUrl: "javascript:alert(1)" }),
		).rejects.toThrow("Invalid Multica URL");
		expect(await readMulticaSettings(stateDir)).toMatchObject({ customUrl: "https://multica.example.com" });
	});

	it("treats a hand-edited invalid URL as unset", async () => {
		await writeFile(file(), `{"version":2,"mode":"local","customUrl":"javascript:alert(1)"}`);
		expect(await readMulticaSettings(stateDir)).toEqual({ mode: "local", customUrl: "", apiUrl: "" });
	});

	it("migrates a version 1 file: a custom URL stays local, Multica Cloud's web app becomes cloud, a cleared URL stays cleared", async () => {
		await writeFile(file(), `{"url":"http://192.168.1.5:3000/"}`);
		expect(await readMulticaSettings(stateDir)).toEqual({ mode: "local", customUrl: "http://192.168.1.5:3000", apiUrl: "" });
		await writeFile(file(), `{"url":"https://multica.ai/"}`);
		expect(await readMulticaSettings(stateDir)).toMatchObject({ mode: "cloud" });
		await writeFile(file(), `{"url":""}`);
		expect(await readMulticaSettings(stateDir)).toEqual({ mode: "local", customUrl: "", apiUrl: "" });
	});

	it("serializes concurrent writes so the last one wins", async () => {
		await Promise.all([
			writeMulticaSettings(stateDir, { mode: "local", customUrl: "http://a.local:3000", apiUrl: "" }),
			writeMulticaSettings(stateDir, { mode: "cloud", customUrl: "http://b.local:3000", apiUrl: "" }),
		]);
		expect(await readMulticaSettings(stateDir)).toEqual({ mode: "cloud", customUrl: "http://b.local:3000", apiUrl: "" });
	});
});
