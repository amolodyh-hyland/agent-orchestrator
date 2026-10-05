// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectBridgeInventory } from "./multica-bridge-inventory.mjs";
import { main } from "./check-multica-bridge.mjs";
import { extractPreloadSurface } from "./multica-preload-surface.mjs";

const frontendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(frontendDirectory, "scripts/check-multica-bridge.mjs");
const preloadRelative = "apps/desktop/src/preload/index.ts";
const declarationRelative = "apps/desktop/src/preload/index.d.ts";
const temporaryDirectories = new Set();

function makeTemporaryDirectory() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multica-bridge-check-"));
	temporaryDirectories.add(directory);
	return directory;
}

function treeSnapshot(root) {
	if (!fs.existsSync(root)) return null;
	const files = [];
	const visit = (directory) => {
		for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, item.name);
			if (item.isDirectory()) visit(absolute);
			else if (item.isFile()) {
				const relative = path.relative(root, absolute).split(path.sep).join("/");
				const digest = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
				files.push(`${relative}\0${digest}`);
			}
		}
	};
	visit(root);
	return files.sort();
}

function renderSurface(entries, inbound = []) {
	const members = [
		...entries.map((entry) => ({ name: entry.api.split(".").at(-1), ...entry })),
		...inbound.map((entry) => ({ name: entry.api.split(".").at(-1), ...entry, kind: "on" })),
	];
	const properties = members.map(({ name, channel, kind }) => {
		const method = kind === "on" ? "on" : kind;
		const callback = kind === "on" ? ", () => {}" : "";
		return `\t${name}: () => ipcRenderer.${method}(${JSON.stringify(channel)}${callback}),`;
	});
	const declarations = members.map(({ name }) => `\t${name}: () => unknown;`);
	return {
		preload: [
			'import { contextBridge, ipcRenderer } from "electron";',
			"const api = {",
			...properties,
			"};",
			'contextBridge.exposeInMainWorld("desktopAPI", api);',
			"window.desktopAPI = api;",
			"",
		].join("\n"),
		declarations: [
			"interface DesktopAPI {",
			...declarations,
			"}",
			"declare global { interface Window { desktopAPI: DesktopAPI; } }",
			"export {};",
			"",
		].join("\n"),
	};
}

function createFixture() {
	const parent = makeTemporaryDirectory();
	const root = path.join(parent, "multica");
	const preloadPath = path.join(root, preloadRelative);
	const declarationPath = path.join(root, declarationRelative);
	fs.mkdirSync(path.dirname(preloadPath), { recursive: true });
	const inventory = collectBridgeInventory();
	const entries = Object.entries(inventory.served).map(([channel, kind]) => ({
		api: "desktopAPI.placeholder",
		channel,
		kind,
	}));
	entries.forEach((entry, index) => {
		entry.api = `desktopAPI.member${index}`;
	});
	const inbound = [
		{ api: "desktopAPI.listener0", channel: "fixture:inbound-one" },
		{ api: "desktopAPI.listener1", channel: "fixture:inbound-two" },
	];
	const writeSurface = (outbound = entries, inboundEntries = inbound) => {
		const source = renderSurface(outbound, inboundEntries);
		fs.writeFileSync(preloadPath, source.preload, "utf8");
		fs.writeFileSync(declarationPath, source.declarations, "utf8");
	};
	writeSurface();
	return {
		parent,
		root,
		preloadPath,
		declarationPath,
		baselinePath: path.join(parent, "baseline.json"),
		entries,
		inbound,
		writeSurface,
	};
}

function extractProbe(preload, extraFiles = {}) {
	const root = "/fixture/multica";
	const contents = new Map([
		[path.join(root, preloadRelative), preload],
		[path.join(root, declarationRelative), "interface API { old(): void; x(): void; } declare global { interface Window { desktopAPI: API; } } export {};"],
	]);
	for (const [relative, content] of Object.entries(extraFiles)) {
		contents.set(path.join(root, relative), content);
	}
	return extractPreloadSurface({
		root,
		readFile: (file) => {
			if (!contents.has(file)) throw new Error(file);
			return contents.get(file);
		},
		fileExists: (file) => contents.has(file),
	});
}

function probePreload(body) {
	return `import {contextBridge, ipcRenderer} from "electron";${body}contextBridge.exposeInMainWorld("desktopAPI", api); window.desktopAPI = api;`;
}

async function runMain(fixture, { argv = [], env = {}, baselinePath = fixture.baselinePath } = {}) {
	const before = treeSnapshot(fixture.root);
	let stdoutText = "";
	let stderrText = "";
	const exitCode = await main({
		argv,
		env,
		cwd: frontendDirectory,
		stdout: { write: (text) => { stdoutText += text; } },
		stderr: { write: (text) => { stderrText += text; } },
		baselinePath,
	});
	expect(treeSnapshot(fixture.root)).toEqual(before);
	return { exitCode, stdout: stdoutText, stderr: stderrText };
}

async function createBaseline(fixture) {
	const result = await runMain(fixture, { argv: ["--multica", fixture.root, "--update-baseline"] });
	expect(result.exitCode).toBe(0);
	return result;
}

afterEach(() => {
	for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
	temporaryDirectories.clear();
});

describe("check-multica-bridge CLI", () => {
	it("passes a fixture matching the real served inventory and writes a baseline", async () => {
		const fixture = createFixture();
		const updated = await createBaseline(fixture);
		expect(updated.stdout).toMatch(/^baseline updated: \d+ entries @ unknown\n$/);
		const baseline = JSON.parse(fs.readFileSync(fixture.baselinePath, "utf8"));
		expect(baseline.entries).toHaveLength(fixture.entries.length + fixture.inbound.length);
		expect(baseline.entries).toEqual([...baseline.entries].sort((left, right) =>
			(left.channel < right.channel ? -1 : left.channel > right.channel ? 1 : 0) ||
			(left.api < right.api ? -1 : left.api > right.api ? 1 : 0) ||
			(left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0),
		));

		const result = await runMain(fixture, { argv: ["--multica", fixture.root] });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/^multica bridge drift check: PASS/m);
		expect(result.stderr).toBe("");
	});

	it("reports an added outbound invoke channel", async () => {
		const fixture = createFixture();
		await createBaseline(fixture);
		const added = [...fixture.entries, { api: "desktopAPI.added", channel: "fixture:added", kind: "invoke" }];
		fixture.writeSurface(added);
		const result = await runMain(fixture, { argv: ["--multica", fixture.root] });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("ADDED");
		expect(result.stdout).toContain('"fixture:added"');
		expect(result.stdout).toContain("desktopAPI.added");
	});

	it("reports a removed served channel", async () => {
		const fixture = createFixture();
		await createBaseline(fixture);
		fixture.writeSurface(fixture.entries.slice(1));
		const result = await runMain(fixture, { argv: ["--multica", fixture.root] });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("REMOVED");
		expect(result.stdout).toContain(JSON.stringify(fixture.entries[0].channel));
	});

	it("pairs a channel rename using the baseline API path", async () => {
		const fixture = createFixture();
		await createBaseline(fixture);
		const index = fixture.entries.findIndex((entry) => entry.kind === "invoke");
		const renamed = fixture.entries.map((entry, entryIndex) => entryIndex === index
			? { ...entry, channel: "fixture:renamed-channel" }
			: entry);
		fixture.writeSurface(renamed);
		const result = await runMain(fixture, { argv: ["--multica", fixture.root] });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("RENAMED");
		expect(result.stdout).toContain(fixture.entries[index].channel);
		expect(result.stdout).toContain("fixture:renamed-channel");
		expect(result.stdout).toContain(fixture.entries[index].api);
		expect(result.stdout).not.toContain("ADDED");
		expect(result.stdout).not.toContain("REMOVED");
	});

	it("reports a changed IPC kind", async () => {
		const fixture = createFixture();
		await createBaseline(fixture);
		const index = fixture.entries.findIndex((entry) => entry.kind === "invoke");
		const changed = fixture.entries.map((entry, entryIndex) => entryIndex === index
			? { ...entry, kind: "send" }
			: entry);
		fixture.writeSurface(changed);
		const result = await runMain(fixture, { argv: ["--multica", fixture.root] });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("CHANGED");
		expect(result.stdout).toContain(fixture.entries[index].channel);
	});

	it("compares inbound additions and accepts them when refreshing the baseline", async () => {
		const fixture = createFixture();
		await createBaseline(fixture);
		const inbound = [...fixture.inbound, { api: "desktopAPI.listenerAdded", channel: "fixture:inbound-added" }];
		fixture.writeSurface(fixture.entries, inbound);
		const drift = await runMain(fixture, { argv: ["--multica", fixture.root] });
		expect(drift.exitCode).toBe(1);
		expect(drift.stdout).toContain("INBOUND");
		expect(drift.stdout).toContain("fixture:inbound-added");

		const updated = await runMain(fixture, { argv: ["--multica", fixture.root, "--update-baseline"] });
		expect(updated.exitCode).toBe(0);
		expect(updated.stdout).toContain("baseline updated:");
		const matching = await runMain(fixture, { argv: ["--multica", fixture.root] });
		expect(matching.exitCode).toBe(0);
		expect(matching.stdout).toMatch(/^multica bridge drift check: PASS/m);
	});

	it("refuses to update the baseline when outbound differences remain", async () => {
		const fixture = createFixture();
		await createBaseline(fixture);
		const previousBytes = fs.readFileSync(fixture.baselinePath);
		const added = [...fixture.entries, { api: "desktopAPI.added", channel: "fixture:added", kind: "invoke" }];
		fixture.writeSurface(added);
		const result = await runMain(fixture, { argv: ["--multica", fixture.root, "--update-baseline"] });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("baseline not updated: the outbound check fails");
		expect(fs.readFileSync(fixture.baselinePath)).toEqual(previousBytes);
	});

	it("reports a missing baseline after the normal report", async () => {
		const fixture = createFixture();
		const result = await runMain(fixture, { argv: ["--multica", fixture.root] });
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toMatch(/^multica bridge drift check: PASS/m);
		expect(result.stderr).toContain('no baseline file: run "npm run check:multica-bridge -- --update-baseline"');
	});

	it("fails closed on a dynamic channel", async () => {
		const fixture = createFixture();
		await createBaseline(fixture);
		const source = fs.readFileSync(fixture.preloadPath, "utf8");
		fs.writeFileSync(fixture.preloadPath, source.replace(/ipcRenderer\.invoke\(("[^"]+")\)/, "ipcRenderer.invoke(dynamicChannel)"), "utf8");
		const result = await runMain(fixture, { argv: ["--multica", fixture.root] });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("ERROR unresolved-channel:");
	});

	it("reports a missing multica checkout", async () => {
		const fixture = createFixture();
		const missingPath = path.join(fixture.parent, "missing-multica");
		const result = await runMain({ ...fixture, root: missingPath }, { argv: ["--multica", missingPath] });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(`multica checkout not found at ${missingPath}`);
		expect(result.stderr).toContain("Pass --multica <dir> or set MULTICA_DIR.");
	});

	it("uses MULTICA_DIR when --multica is omitted", async () => {
		const fixture = createFixture();
		await createBaseline(fixture);
		const result = await runMain(fixture, { env: { MULTICA_DIR: fixture.root } });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/^multica bridge drift check: PASS/m);
	});

	it("rejects invalid JSON baselines before running the diff", async () => {
		const fixture = createFixture();
		fs.writeFileSync(fixture.baselinePath, "not json\n", "utf8");
		const result = await runMain(fixture, { argv: ["--multica", fixture.root] });
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`baseline file is invalid: invalid JSON: `);
		expect(result.stderr).toContain(`(${fixture.baselinePath})`);
	});

	it("rejects an unreadable baseline with a readable error", async () => {
		const fixture = createFixture();
		fs.mkdirSync(fixture.baselinePath);
		const result = await runMain(fixture, { argv: ["--multica", fixture.root] });
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`baseline file is invalid: `);
		expect(result.stderr).toContain(`(${fixture.baselinePath})`);
	});

	it.each([
		["JSON null", () => "null"],
		["an empty object", () => "{}"],
		["a non-array entries value", (baseline) => ({ ...baseline, entries: {} })],
		["an unsupported entry kind", (baseline) => ({
			...baseline,
			entries: [{ ...baseline.entries[0], kind: "listen" }, ...baseline.entries.slice(1)],
		})],
		["non-array globals", (baseline) => ({ ...baseline, globals: "desktopAPI" })],
		["non-array member lists", (baseline) => ({ ...baseline, members: { desktopAPI: "open" } })],
	])("rejects a schema-invalid baseline with %s", async (_name, makeInvalid) => {
		const fixture = createFixture();
		await createBaseline(fixture);
		const valid = JSON.parse(fs.readFileSync(fixture.baselinePath, "utf8"));
		const invalid = makeInvalid(valid);
		fs.writeFileSync(fixture.baselinePath, typeof invalid === "string" ? invalid : JSON.stringify(invalid), "utf8");
		const result = await runMain(fixture, { argv: ["--multica", fixture.root] });
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`baseline file is invalid: `);
		expect(result.stderr).toContain(`(${fixture.baselinePath})`);
	});

	it("replaces a corrupt baseline when updating after the outbound check passes", async () => {
		const fixture = createFixture();
		fs.writeFileSync(fixture.baselinePath, "not json\n", "utf8");
		const result = await runMain(fixture, {
			argv: ["--multica", fixture.root, "--update-baseline"],
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/^baseline updated: \d+ entries @ unknown\n$/);
		const baseline = JSON.parse(fs.readFileSync(fixture.baselinePath, "utf8"));
		expect(baseline).toMatchObject({
			multicaCommit: null,
			preload: preloadRelative,
			globals: ["desktopAPI"],
		});
		expect(Array.isArray(baseline.members.desktopAPI)).toBe(true);
		expect(baseline.entries.every(({ api, channel, kind }) =>
			typeof api === "string" && typeof channel === "string" &&
			["invoke", "send", "sendSync", "on", "postMessage", "sendToHost"].includes(kind),
		)).toBe(true);
	});

	it("reports an unexpected error from the CLI body as exit 2", async () => {
		const fixture = createFixture();
		const result = await runMain(fixture, {
			argv: ["--multica", fixture.root],
			baselinePath: {},
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/^unexpected error: /);
	});

	it("prints usage for help and rejects unknown flags", async () => {
		const fixture = createFixture();
		const help = await runMain(fixture, { argv: ["--help"] });
		expect(help.exitCode).toBe(0);
		expect(help.stdout).toContain("Usage: npm run check:multica-bridge");
		const unknown = await runMain(fixture, { argv: ["--unknown"] });
		expect(unknown.exitCode).toBe(2);
		expect(unknown.stderr).toContain("Usage: npm run check:multica-bridge");
	});

	it("supports direct CLI execution with the package warning flag", () => {
		const fixture = createFixture();
		const before = treeSnapshot(fixture.root);
		const child = spawnSync(process.execPath, [
			"--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
			scriptPath,
			"--multica",
			fixture.root,
			"--help",
		], { cwd: frontendDirectory, encoding: "utf8" });
		expect(treeSnapshot(fixture.root)).toEqual(before);
		expect(child.status).toBe(0);
		expect(child.stdout).toContain("Usage: npm run check:multica-bridge");
	});

});

describe("reviewed preload fail-closed cases", () => {
	it("rejects IPC in an imported helper module", () => {
		const surface = extractProbe(
			probePreload('import {request} from "./helper"; const api = {old:()=>ipcRenderer.invoke("old"),x:()=>request()};'),
			{
				"apps/desktop/src/preload/helper.ts": 'import {ipcRenderer} from "electron"; export function request() { return ipcRenderer.invoke("new:unserved"); }',
			},
		);

		expect(surface.issues.map(({ code }) => code)).toContain("ipc-in-imported-module");
		expect(surface.entries.some(({ channel }) => channel === "new:unserved")).toBe(false);
	});

	it("rejects a shadowed module channel constant", () => {
		const surface = extractProbe(probePreload('const CHANNEL = "old"; const api = {old:()=>ipcRenderer.invoke("old"),x:()=>{const CHANNEL="new:unserved";return ipcRenderer.invoke(CHANNEL);}};'));

		expect(surface.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
			"shadowed-channel",
			"unresolved-channel",
		]));
	});

	it("rejects a helper reference that escapes through an alias", () => {
		const surface = extractProbe(probePreload('function request(channel) {return ipcRenderer.invoke(channel);} const ask = request; const api = {old:()=>request("old"),x:()=>ask("new:unserved")};'));

		expect(surface.issues.map(({ code }) => code)).toContain("escaped-helper");
	});

	it("rejects a reassigned helper channel parameter", () => {
		const surface = extractProbe(probePreload('function request(channel) {channel="new:unserved";return ipcRenderer.invoke(channel);} const api = {old:()=>ipcRenderer.invoke("old"),x:()=>request("old")};'));

		expect(surface.issues.map(({ code }) => code)).toContain("reassigned-channel-parameter");
	});

	it("rejects an unsupported exposed API factory", () => {
		const surface = extractProbe(probePreload('function makeAPI(){return {x:()=>ipcRenderer.invoke("old")};} const api = makeAPI();'));

		expect(surface.issues.map(({ code }) => code)).toContain("unsupported-exposed-api");
	});

	it("rejects an imported spread in the exposed API", () => {
		const surface = extractProbe(
			probePreload('import {extraAPI} from "./helper"; const api = {old:()=>ipcRenderer.invoke("old"),...extraAPI};'),
			{
				"apps/desktop/src/preload/helper.ts": 'import {ipcRenderer} from "electron"; export const extraAPI = {x:()=>ipcRenderer.invoke("new:unserved")};',
			},
		);

		expect(surface.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
			"ipc-in-imported-module",
			"unsupported-exposed-member",
		]));
	});

	it("rejects a missing re-export dependency", () => {
		const surface = extractProbe(
			probePreload('import {request} from "./helper"; const api = {old:()=>ipcRenderer.invoke("old"),x:()=>request()};'),
			{ "apps/desktop/src/preload/helper.ts": 'export { request } from "./missing";' },
		);

		expect(surface.issues.map(({ code }) => code)).toContain("missing-import");
	});
});

describe.skipIf(!process.env.MULTICA_DIR)("real multica pin", () => {
	it("passes against the supplied checkout and committed baseline", async () => {
		const output = { write: (text) => { output.text += text; }, text: "" };
		const errorOutput = { write: (text) => { errorOutput.text += text; }, text: "" };
		const exitCode = await main({
			argv: [],
			env: { MULTICA_DIR: process.env.MULTICA_DIR },
			cwd: frontendDirectory,
			stdout: output,
			stderr: errorOutput,
		});
		expect(exitCode).toBe(0);
		expect(output.text).toMatch(/^multica bridge drift check: PASS/m);
		expect(errorOutput.text).toBe("");
	});
});
