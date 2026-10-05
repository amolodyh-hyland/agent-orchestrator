// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffBridge } from "./multica-bridge-drift.mjs";
import { extractPreloadSurface } from "./multica-preload-surface.mjs";

const root = "/fixture/multica";
const preloadPath = "apps/desktop/src/preload/index.ts";
const declarationsPath = "apps/desktop/src/preload/index.d.ts";
const defaultDeclarations = `
interface DesktopAPI { x: () => void; }
declare global { interface Window { desktopAPI: DesktopAPI; } }
export {};
`;

function fixture(preload, { files = {}, declarations = defaultDeclarations } = {}) {
	const contents = new Map([[path.join(root, preloadPath), preload]]);
	if (declarations !== null) contents.set(path.join(root, declarationsPath), declarations);
	for (const [relative, text] of Object.entries(files)) contents.set(path.join(root, relative), text);
	return {
		root,
		readFile: (absPath) => {
			if (!contents.has(absPath)) throw new Error(`No fixture file: ${absPath}`);
			return contents.get(absPath);
		},
		fileExists: (absPath) => contents.has(absPath),
	};
}

function basicPreload(body, { exposure = `contextBridge.exposeInMainWorld("desktopAPI", api);`, fallback = `window.desktopAPI = api;` } = {}) {
	return `import { contextBridge, ipcRenderer } from "electron";
const api = { ${body} };
if (process.contextIsolated) { ${exposure} } else { ${fallback} }
`;
}

function extract(preload, options) {
	return extractPreloadSurface(fixture(preload, options));
}

function entrySignature(surface) {
	return surface.entries.map(({ api, channel, kind, direction }) => ({ api, channel, kind, direction }));
}

function baselineFor(surface) {
	return {
		multicaCommit: null,
		preload: surface.preloadFile,
		globals: surface.globals,
		members: surface.members,
		entries: surface.entries.map(({ api, channel, kind }) => ({ api, channel, kind })),
	};
}

describe("extractPreloadSurface", () => {
	it("extracts every watched literal kind and normalizes inbound listener methods", () => {
		const surface = extract(basicPreload(`
			invoke: () => ipcRenderer.invoke("literal:invoke"),
			send: () => ipcRenderer.send("literal:send"),
			sendSync: () => ipcRenderer.sendSync("literal:send-sync"),
			on: () => ipcRenderer.on("literal:on", () => {}),
			once: () => ipcRenderer.once("literal:once", () => {}),
			add: () => ipcRenderer.addListener("literal:add", () => {}),
			template: () => ipcRenderer.invoke(\`literal:template\`),
			post: () => ipcRenderer.postMessage("literal:post", null),
			host: () => ipcRenderer.sendToHost("literal:host", null),
		`));

		expect(surface.issues).toEqual([]);
		expect(surface.entries.map(({ channel, kind, direction }) => ({ channel, kind, direction }))).toEqual([
			{ channel: "literal:add", kind: "on", direction: "inbound" },
			{ channel: "literal:host", kind: "sendToHost", direction: "outbound" },
			{ channel: "literal:invoke", kind: "invoke", direction: "outbound" },
			{ channel: "literal:on", kind: "on", direction: "inbound" },
			{ channel: "literal:once", kind: "on", direction: "inbound" },
			{ channel: "literal:post", kind: "postMessage", direction: "outbound" },
			{ channel: "literal:send", kind: "send", direction: "outbound" },
			{ channel: "literal:send-sync", kind: "sendSync", direction: "outbound" },
			{ channel: "literal:template", kind: "invoke", direction: "outbound" },
		]);
	});

	it("resolves imported constants and a single local alias hop", () => {
		const preload = `import { contextBridge, ipcRenderer } from "electron";
import { SHARED_CHANNEL } from "../shared/channels";
import { INDEX_CHANNEL } from "../shared/nested";
const LOCAL_ALIAS = SHARED_CHANNEL;
const LOCAL_CHANNEL = "local:channel" as const;
const api = {
	request: () => ipcRenderer.invoke(LOCAL_ALIAS),
	direct: () => ipcRenderer.sendSync(INDEX_CHANNEL),
	local: () => ipcRenderer.send(LOCAL_CHANNEL),
};
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;
`;
		const surface = extract(preload, {
			files: {
				"apps/desktop/src/shared/channels.ts": `export const SHARED_CHANNEL = "shared:channel" as const;`,
				"apps/desktop/src/shared/nested/index.ts": `export const INDEX_CHANNEL = "index:channel";`,
			},
		});
		expect(surface.issues).toEqual([]);
		expect(surface.entries).toMatchObject([
			{ api: "desktopAPI.direct", channel: "index:channel", kind: "sendSync" },
			{ api: "desktopAPI.local", channel: "local:channel", kind: "send" },
			{ api: "desktopAPI.request", channel: "shared:channel", kind: "invoke" },
		]);
	});

	it("propagates helper parameters to both call sites and keeps helper constants separate", () => {
		const preload = `import { contextBridge, ipcRenderer } from "electron";
import { READY_CHANNEL } from "../shared/channels";
function subscribeToMainRendererChannel(channel, callback) {
	const handler = (_event, payload) => callback(payload);
	ipcRenderer.on(channel, handler);
	ipcRenderer.send(READY_CHANNEL, { channel, ready: true });
	return () => ipcRenderer.removeListener(channel, handler);
}
const api = {
	first: () => subscribeToMainRendererChannel("first:channel", () => {}),
	second: () => subscribeToMainRendererChannel("second:channel", () => {}),
};
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;
`;
		const surface = extract(preload, {
			files: { "apps/desktop/src/shared/channels.ts": `export const READY_CHANNEL = "main-renderer:channel-state";` },
		});
		expect(surface.issues).toEqual([]);
		expect(surface.entries).toEqual([
			{
				api: "desktopAPI.first",
				channel: "first:channel",
				kind: "on",
				direction: "inbound",
				file: preloadPath,
				line: 10,
			},
			{
				api: "(helper) subscribeToMainRendererChannel",
				channel: "main-renderer:channel-state",
				kind: "send",
				direction: "outbound",
				file: preloadPath,
				line: 6,
			},
			{
				api: "desktopAPI.second",
				channel: "second:channel",
				kind: "on",
				direction: "inbound",
				file: preloadPath,
				line: 11,
			},
		]);
	});

	it("treats listener removal methods as bookkeeping while resolving their channels", () => {
		const surface = extract(basicPreload(`
			remove: () => ipcRenderer.removeListener("book:remove", handler),
			off: () => ipcRenderer.off("book:off", handler),
			all: () => ipcRenderer.removeAllListeners("book:all"),
		`));
		expect(surface.entries).toEqual([]);
		expect(surface.issues).toEqual([]);
	});

	it("keeps the first occurrence of a repeated API, channel, and kind", () => {
		const surface = extract(basicPreload(`
			request: () => {
				ipcRenderer.invoke("same:channel");
				ipcRenderer.invoke("same:channel");
			},
		`));
		expect(surface.entries).toHaveLength(1);
		expect(surface.entries[0]).toMatchObject({ api: "desktopAPI.request", channel: "same:channel", kind: "invoke", line: 4 });
	});

	it("builds nested API paths from the exposed global name, not the variable name", () => {
		const preload = `import { contextBridge, ipcRenderer } from "electron";
const internal = { group: { listen: () => ipcRenderer.once("nested:channel", handler) }, open: () => ipcRenderer.invoke("open:channel") };
contextBridge.exposeInMainWorld("publicAPI", internal);
window.publicAPI = internal;
`;
		const surface = extract(preload);
		expect(surface.globals).toEqual(["publicAPI"]);
		expect(surface.members).toEqual({ publicAPI: ["group", "open"] });
		expect(surface.entries.map(({ api, channel }) => ({ api, channel }))).toEqual([
			{ api: "publicAPI.group.listen", channel: "nested:channel" },
			{ api: "publicAPI.open", channel: "open:channel" },
		]);
	});

	it("labels watched calls in module functions", () => {
		const preload = `import { contextBridge, ipcRenderer } from "electron";
function fetchAppInfo() { return ipcRenderer.sendSync("app:get-info"); }
const api = { value: 1 };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;
`;
		const surface = extract(preload);
		expect(surface.issues).toEqual([]);
		expect(surface.entries).toMatchObject([
			{ api: "(module) fetchAppInfo", channel: "app:get-info", kind: "sendSync" },
		]);
	});

	it("supports an exposed API object asserted as const", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
const api = { old: () => ipcRenderer.invoke("old") } as const;
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues).toEqual([]);
		expect(surface.entries).toMatchObject([{ api: "desktopAPI.old", channel: "old", kind: "invoke" }]);
	});

	it("labels exposed module function references as best effort", () => {
		const source = `import { contextBridge, ipcRenderer } from "electron";
function auth(callback) { return ipcRenderer.on("auth:token", callback); }
function invite(callback) { return ipcRenderer.on("invite:open", callback); }
const api = { onAuth: auth, invite };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`;
		const surface = extract(source);
		expect(surface.issues).toEqual([]);
		expect(surface.entries.map(({ api, channel }) => ({ api, channel }))).toEqual([
			{ api: "(module) auth", channel: "auth:token" },
			{ api: "(module) invite", channel: "invite:open" },
		]);
	});

	it("keeps channel and kind drift clean when inline API wrappers swap module helpers", () => {
		const source = `import { contextBridge, ipcRenderer } from "electron";
function auth(callback) { return ipcRenderer.on("auth:token", callback); }
function invite(callback) { return ipcRenderer.on("invite:open", callback); }
const api = { onAuth: (callback) => auth(callback), onInvite: (callback) => invite(callback) };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`;
		const before = extract(source);
		const after = extract(source.replace("onAuth: (callback) => auth(callback), onInvite: (callback) => invite(callback)", "onAuth: (callback) => invite(callback), onInvite: (callback) => auth(callback)"));
		const report = diffBridge({ surface: after, inventory: { served: {}, issues: [] }, baseline: baselineFor(before) });

		expect(before.issues).toEqual([]);
		expect(after.issues).toEqual([]);
		expect(after.entries.map(({ api, channel }) => ({ api, channel }))).toEqual([
			{ api: "(module) auth", channel: "auth:token" },
			{ api: "(module) invite", channel: "invite:open" },
		]);
		expect(report.ok).toBe(true);
	});

	it("keeps channel and kind drift clean when exposed members reference nested constant objects", () => {
		const source = `import { contextBridge, ipcRenderer } from "electron";
const authGroup = { listen: (callback) => ipcRenderer.on("auth:token", callback) };
const inviteGroup = { listen: (callback) => ipcRenderer.on("invite:open", callback) };
const api = { auth: authGroup, invite: inviteGroup };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`;
		const before = extract(source);
		const after = extract(source.replace("const api = { auth: authGroup, invite: inviteGroup };", "const api = { auth: inviteGroup, invite: authGroup };"));
		const report = diffBridge({ surface: after, inventory: { served: {}, issues: [] }, baseline: baselineFor(before) });

		expect(before.issues).toEqual([]);
		expect(after.issues).toEqual([]);
		expect(after.entries.map(({ api, channel }) => ({ api, channel }))).toEqual([
			{ api: "(module) listen", channel: "auth:token" },
			{ api: "(module) listen", channel: "invite:open" },
		]);
		expect(report.ok).toBe(true);
	});

	it("reads local interface members from index.d.ts and omits imported interface types", () => {
		const preload = `import { contextBridge, ipcRenderer } from "electron";
import { electronAPI as externalAPI } from "@electron-toolkit/preload";
const api = { listen: () => ipcRenderer.on("listen:channel", handler) };
const daemon = { start: () => ipcRenderer.invoke("daemon:start") };
contextBridge.exposeInMainWorld("desktopAPI", api);
contextBridge.exposeInMainWorld("daemonAPI", daemon);
contextBridge.exposeInMainWorld("electron", externalAPI);
window.desktopAPI = api;
window.daemonAPI = daemon;
window.electron = externalAPI;
`;
		const declarations = `import { ElectronAPI } from "@electron-toolkit/preload";
interface DesktopAPI { listen: () => void; value: string; }
interface DaemonAPI { start: () => void; stop(): void; }
interface Window { desktopAPI: DesktopAPI; }
declare global { interface Window { daemonAPI: DaemonAPI; electron: ElectronAPI; } }
export {};
`;
		const surface = extract(preload, { declarations });
		expect(surface.issues).toEqual([]);
		expect(surface.declaredMembers).toEqual({ desktopAPI: ["listen", "value"], daemonAPI: ["start", "stop"] });
	});

	it("fails closed when an imported helper module contains IPC", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
import { request } from "./helper";
const api = { old: () => ipcRenderer.invoke("old"), x: () => request() };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`, {
			files: {
				"apps/desktop/src/preload/helper.ts": `import { ipcRenderer } from "electron";
export function request() { return ipcRenderer.invoke("new:unserved"); }`,
			},
		});
		expect(surface.issues.filter(({ code }) => code === "ipc-in-imported-module")).toEqual([
			{ code: "ipc-in-imported-module", message: "Imported module contains ipcRenderer", file: "apps/desktop/src/preload/helper.ts", line: 1 },
		]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
	});

	it("detects an imported channel constant shadowed by a local binding", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
import { CHANNEL } from "../shared/channels";
const api = {
	old: () => ipcRenderer.invoke("old"),
	x: () => { const CHANNEL = "new:unserved"; return ipcRenderer.invoke(CHANNEL); },
};
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`, {
			files: { "apps/desktop/src/shared/channels.ts": `export const CHANNEL = "old";` },
		});
		expect(surface.issues.map(({ code }) => code)).toContain("shadowed-channel");
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
	});

	it("reports a module channel constant shadowed at the IPC call", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
const CHANNEL = "old";
const api = {
	old: () => ipcRenderer.invoke("old"),
	x: () => { const CHANNEL = "new:unserved"; return ipcRenderer.invoke(CHANNEL); },
};
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues.filter(({ code }) => code === "shadowed-channel")).toEqual([
			{ code: "shadowed-channel", message: "Module channel CHANNEL is shadowed at its use site", file: preloadPath, line: 5 },
		]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
	});

	it("reports an escaped channel helper reference", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
function request(channel) { return ipcRenderer.invoke(channel); }
const ask = request;
const api = { old: () => request("old"), x: () => ask("new:unserved") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues.filter(({ code }) => code === "escaped-helper")).toEqual([
			{ code: "escaped-helper", message: "Helper request is referenced outside a direct call", file: preloadPath, line: 3 },
		]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
	});

	it("rejects helper references passed, stored in objects, or exported", () => {
		const references = ["const escaped = take(request);", "const escaped = { fn: request };", "export { request };"];
		for (const reference of references) {
			const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
function request(channel) { return ipcRenderer.invoke(channel); }
${reference}
const api = { x: () => request("old") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
			expect(surface.issues.map(({ code }) => code), reference).toContain("escaped-helper");
		}
	});

	it("reports a reassigned helper channel parameter", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
function request(channel) {
	channel = "new:unserved";
	return ipcRenderer.invoke(channel);
}
const api = { x: () => request("old") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues.filter(({ code }) => code === "reassigned-channel-parameter")).toEqual([
			{ code: "reassigned-channel-parameter", message: "Helper channel parameter channel is reassigned", file: preloadPath, line: 3 },
		]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
	});

	it.each([
		`{ const channel = "new:unserved"; return ipcRenderer.invoke(channel); }`,
		`{ let channel = "old"; channel = "new:unserved"; return ipcRenderer.invoke(channel); }`,
	])("rejects a helper channel parameter shadowed in a nested block", (body) => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
function request(channel) ${body}
const api = { old: () => ipcRenderer.invoke("old"), x: () => request("old") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues.map(({ code }) => code)).toContain("shadowed-channel-parameter");
	});

	it("does not mistake an unrelated inner arrow parameter for a helper channel shadow", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
function request(channel) { const format = (channel) => String(channel); return ipcRenderer.invoke(channel); }
const api = { old: () => request("old") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues).toEqual([]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
	});

	it("ignores a same-named parameter in a sibling callback while detecting an inner shadow at the IPC use", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
function request(channel) { const format = (channel) => String(channel); return ipcRenderer.invoke(channel); }
function shadowed(channel) { { const channel = "inner"; return ipcRenderer.invoke(channel); } }
const api = { request: () => request("old"), shadowed: () => shadowed("inner") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues.filter(({ code }) => code === "shadowed-channel-parameter")).toHaveLength(1);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["inner", "old"]);
	});

	it("unwraps erasable assertions before resolving constants and helper parameters", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
const CHANNEL = "old";
function request(channel) { return ipcRenderer.invoke(channel as string); }
const api = {
	as: () => ipcRenderer.invoke(CHANNEL as string),
	nonNull: () => ipcRenderer.invoke(CHANNEL!),
	angle: () => ipcRenderer.invoke(<string>CHANNEL),
	satisfies: () => ipcRenderer.invoke(CHANNEL satisfies string),
	helper: () => request("helper" as string),
};
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues).toEqual([]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["helper", "old", "old", "old", "old"]);
		expect(surface.entries).toMatchObject([
			{ api: "desktopAPI.helper", channel: "helper" },
			{ api: "desktopAPI.angle", channel: "old" },
			{ api: "desktopAPI.as", channel: "old" },
			{ api: "desktopAPI.nonNull", channel: "old" },
			{ api: "desktopAPI.satisfies", channel: "old" },
		]);
	});

	it("treats a var initializer that reinitializes a helper parameter as a write", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
function request(channel) { var channel = "new:unserved"; return ipcRenderer.invoke(channel); }
const api = { old: () => ipcRenderer.invoke("old"), x: () => request("old") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues.map(({ code }) => code)).toContain("reassigned-channel-parameter");
		expect(surface.issues.map(({ code }) => code)).toContain("shadowed-channel-parameter");
	});

	it("rejects compound, update, destructuring, and loop writes to helper channel parameters", () => {
		const mutations = [
			`channel += ":changed";`,
			`channel++;`,
			`({ channel } = { channel: "changed" });`,
			`for (channel of values) {}`,
			`for (channel in values) {}`,
		];
		for (const mutation of mutations) {
			const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
function request(channel) { ${mutation} return ipcRenderer.invoke(channel); }
const api = { x: () => request("old") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
			expect(surface.issues.map(({ code }) => code), mutation).toContain("reassigned-channel-parameter");
		}
	});

	it("rejects an exposed API factory result without dropping its IPC call", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
function makeAPI() { return { x: () => ipcRenderer.invoke("old") }; }
const api = makeAPI();
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues.filter(({ code }) => code === "unsupported-exposed-api")).toEqual([
			{ code: "unsupported-exposed-api", message: "Unsupported exposed API value: api", file: preloadPath, line: 4 },
		]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
	});

	it("rejects an exposed API spread and catches IPC in its imported module", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
import { extraAPI } from "./helper";
const api = {
	old: () => ipcRenderer.invoke("old"),
	...extraAPI,
};
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`, {
			files: {
				"apps/desktop/src/preload/helper.ts": `import { ipcRenderer } from "electron";
export const extraAPI = { x: () => ipcRenderer.invoke("new:unserved") };`,
			},
		});
		expect(surface.issues.filter(({ code }) => code === "unsupported-exposed-member")).toEqual([
			{ code: "unsupported-exposed-member", message: "Spread members are not supported in an exposed API object", file: preloadPath, line: 5 },
		]);
		expect(surface.issues.map(({ code }) => code)).toContain("ipc-in-imported-module");
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
	});

	it("loads relative re-exports and reports a missing re-export target", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
import { request } from "./helper";
const api = { old: () => ipcRenderer.invoke("old"), x: () => request() };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`, {
			files: { "apps/desktop/src/preload/helper.ts": `export { request } from "./missing";` },
		});
		expect(surface.issues.filter(({ code }) => code === "missing-import")).toEqual([
			expect.objectContaining({ code: "missing-import", file: "apps/desktop/src/preload/helper.ts", line: 1 }),
		]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
	});

	it("rejects a relative import used as the exposed API value", () => {
		const surface = extract(`import { contextBridge } from "electron";
import { api } from "./helper";
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`, {
			files: { "apps/desktop/src/preload/helper.ts": `export const api = { x: () => {} };` },
		});
		expect(surface.issues.map(({ code }) => code)).toContain("unsupported-exposed-api");
	});

	it("supports an inline exposed object and builds paths from its exposed global", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
const fallback = {};
contextBridge.exposeInMainWorld("publicAPI", { group: { listen: () => ipcRenderer.invoke("inline:channel") } });
window.publicAPI = fallback;`);
		expect(surface.issues).toEqual([]);
		expect(surface.members).toEqual({ publicAPI: ["group"] });
		expect(surface.entries).toMatchObject([{ api: "publicAPI.group.listen", channel: "inline:channel" }]);
	});

	it("accepts an exposed API imported from a non-relative package without recording members", () => {
		const surface = extract(`import { contextBridge } from "electron";
import { electronAPI } from "@electron-toolkit/preload";
contextBridge.exposeInMainWorld("electron", electronAPI);
window.electron = electronAPI;`);
		expect(surface.issues).toEqual([]);
		expect(surface.globals).toEqual(["electron"]);
		expect(surface.members).toEqual({});
	});

	it("allows a shared constant module with a type-only electron import", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
import { SHARED_CHANNEL } from "../shared/channels";
const api = { x: () => ipcRenderer.invoke(SHARED_CHANNEL) };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`, {
			files: { "apps/desktop/src/shared/channels.ts": `import type { IpcRenderer } from "electron";\nexport const SHARED_CHANNEL = "shared:channel";` },
		});
		expect(surface.issues).toEqual([]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["shared:channel"]);
	});

	it("ignores imported type-only ipcRenderer references and keeps the shared constant", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
import { CHANNEL } from "../shared/channels";
const api = { old: () => ipcRenderer.invoke(CHANNEL) };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`, {
			files: {
				"apps/desktop/src/shared/channels.ts": `import type { ipcRenderer } from "electron";\nexport type Renderer = typeof ipcRenderer;\nexport const CHANNEL = "old";`,
			},
		});
		expect(surface.issues).toEqual([]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
	});

	it("ignores type-only electron re-exports and declarations", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
import { CHANNEL } from "../shared/channels";
const api = { old: () => ipcRenderer.invoke(CHANNEL) };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`, {
			files: {
				"apps/desktop/src/shared/channels.ts": `export type { ipcRenderer } from "electron";\nexport type Renderer = typeof ipcRenderer;\nexport const CHANNEL = "old";`,
			},
		});
		expect(surface.issues).toEqual([]);
	});

	it("skips type-only relative imports and exports during runtime module discovery", () => {
		const options = fixture(`import { contextBridge, ipcRenderer } from "electron";
import type { Result } from "../shared/types";
import type { Missing } from "../shared/gone";
export type { Missing as ExportedMissing } from "./gone";
export type * from "./other";
const api = { old: () => ipcRenderer.invoke("old") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`, {
			files: { "apps/desktop/src/shared/types.d.ts": "export interface Result { value: string; }" },
		});
		const reads = [];
		const surface = extractPreloadSurface({
			...options,
			readFile: (absPath) => {
				reads.push(absPath);
				return options.readFile(absPath);
			},
		});

		expect(surface.issues).toEqual([]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
		expect(reads).not.toContain(path.join(root, "apps/desktop/src/shared/types.d.ts"));
	});

	it("still loads a mixed value and type import as a runtime dependency", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
import { A, type B } from "../shared/missing";
const api = { old: () => ipcRenderer.invoke("old") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues.filter(({ code }) => code === "missing-import")).toHaveLength(1);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
	});

	it.each([
		`import * as electron from "electron";`,
		`import electron from "electron";`,
		`const electron = require("electron");`,
		`const electron = import("electron");`,
		`import electron = require("electron");`,
	])("rejects unsupported runtime Electron access in an imported module: %s", (runtimeUse) => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
import { CHANNEL } from "../shared/channels";
const api = { old: () => ipcRenderer.invoke(CHANNEL) };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`, {
			files: { "apps/desktop/src/shared/channels.ts": `${runtimeUse}\nexport const CHANNEL = "old";` },
		});
		expect(surface.issues.map(({ code }) => code)).toContain("unsupported-electron-import");
		expect(surface.issues.find(({ code }) => code === "unsupported-electron-import").file).toBe("apps/desktop/src/shared/channels.ts");
	});

	it("reports computed Electron ipcRenderer receivers in the preload", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
import * as electron from "electron";
const api = { old: () => ipcRenderer.invoke("old"), x: () => electron["ipcRenderer"].invoke("new:unserved") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues.map(({ code }) => code)).toContain("unsupported-electron-import");
		expect(surface.issues.map(({ code }) => code)).toContain("ipcrenderer-alias");
	});

	it("reports a property access to ipcRenderer on a non-import object", () => {
		const surface = extract(`import { contextBridge } from "electron";
const api = { x: () => window.electron.ipcRenderer.invoke("new:unserved") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues.map(({ code }) => code)).toContain("ipcrenderer-alias");
	});

	it("ignores IPC identifiers in preload type positions", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
type PreloadTypes = typeof ipcRenderer | typeof contextBridge | typeof electron;
interface PreloadInterface { ipcRenderer: typeof ipcRenderer; contextBridge: typeof contextBridge; electron: typeof electron; }
const api = { old: () => ipcRenderer.invoke("old") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues).toEqual([]);
	});

	it("reports a computed Electron ipcRenderer receiver in an imported module", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
import { request } from "./helper";
const api = { old: () => ipcRenderer.invoke("old"), x: () => request() };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`, {
			files: { "apps/desktop/src/preload/helper.ts": `const e = require("electron");\nexport function request() { return e["ipcRenderer"].invoke("new:unserved"); }` },
		});
		expect(surface.issues.map(({ code }) => code)).toContain("unsupported-electron-import");
		expect(surface.issues.map(({ code }) => code)).toContain("ipcrenderer-alias");
	});

	it.skipIf(!process.env.MULTICA_DIR)("detects a computed receiver injected into the real pinned preload", () => {
		const multicaRoot = process.env.MULTICA_DIR;
		const preloadPathOnDisk = path.join(multicaRoot, preloadPath);
		const original = fs.readFileSync(preloadPathOnDisk, "utf8");
		const modified = original
			.replace('import { contextBridge, ipcRenderer } from "electron";', 'import { contextBridge, ipcRenderer } from "electron";\nimport * as electron from "electron";')
			.replace('openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),', 'openExternal: (url: string) => { electron["ipcRenderer"].invoke("probe:new", url); return ipcRenderer.invoke("shell:openExternal", url); },');
		expect(modified).not.toBe(original);
		const surface = extractPreloadSurface({
			root: multicaRoot,
			readFile: (absPath) => absPath === preloadPathOnDisk ? modified : fs.readFileSync(absPath, "utf8"),
		});
		expect(surface.entries).toHaveLength(52);
		expect(surface.issues.map(({ code }) => code)).toContain("unsupported-electron-import");
		expect(surface.issues.map(({ code }) => code)).toContain("ipcrenderer-alias");
	});

	it("rejects runtime electron imports and re-exports in reachable modules", () => {
		const surface = extract(`import { contextBridge } from "electron";
import { VALUE } from "../shared/runtime-import";
import { EXPORTED } from "../shared/runtime-export";
const api = { value: VALUE, exported: EXPORTED };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`, {
			files: {
				"apps/desktop/src/shared/runtime-import.ts": `import "electron";\nexport const VALUE = "value";`,
				"apps/desktop/src/shared/runtime-export.ts": `export { app } from "electron";\nexport const EXPORTED = "exported";`,
			},
		});
		expect(surface.issues.filter(({ code }) => code === "ipc-in-imported-module").map(({ file }) => file)).toEqual([
			"apps/desktop/src/shared/runtime-export.ts",
			"apps/desktop/src/shared/runtime-import.ts",
		]);
	});

	it("rejects dynamic and numeric exposed member names", () => {
		const surface = extract(`import { contextBridge } from "electron";
const dynamic = "x";
const api = { [dynamic]: 1, 2: 2 };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues.filter(({ code }) => code === "unsupported-exposed-member")).toHaveLength(2);
	});

	it("does not mistake a differently named local for a channel shadow", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
const CHANNEL = "old";
const api = { x: () => { const localChannel = "new"; return ipcRenderer.invoke(CHANNEL); } };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues).toEqual([]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["old"]);
	});

	it("propagates helper channels for many direct calls", () => {
		const surface = extract(`import { contextBridge, ipcRenderer } from "electron";
const channel = "module:constant";
function request(channel) { return ipcRenderer.invoke(channel); }
const api = {
	first: () => request("first"),
	second: () => request("second"),
	third: () => request("third"),
};
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;`);
		expect(surface.issues).toEqual([]);
		expect(surface.entries.map(({ channel }) => channel)).toEqual(["first", "second", "third"]);
	});

	it("fails closed for every unsupported or inconsistent surface shape", () => {
		const cases = [
			{
				code: "unresolved-channel",
				preload: `import { contextBridge, ipcRenderer } from "electron"; const api = { x: () => ipcRenderer.invoke(channel) }; contextBridge.exposeInMainWorld("desktopAPI", api); window.desktopAPI = api;`,
			},
			{
				code: "unresolved-channel",
				preload: `import { contextBridge, ipcRenderer } from "electron"; const api = { x: () => ipcRenderer.removeListener(channel, handler) }; contextBridge.exposeInMainWorld("desktopAPI", api); window.desktopAPI = api;`,
			},
			{
				code: "missing-import",
				preload: `import { contextBridge, ipcRenderer } from "electron"; import { CHANNEL } from "../shared/missing"; const api = { x: () => ipcRenderer.invoke(CHANNEL) }; contextBridge.exposeInMainWorld("desktopAPI", api); window.desktopAPI = api;`,
			},
			{
				code: "unresolved-helper-channel",
				preload: `import { contextBridge, ipcRenderer } from "electron"; function subscribe(channel) { ipcRenderer.on(channel, handler); } const api = { x: () => subscribe(dynamicChannel) }; contextBridge.exposeInMainWorld("desktopAPI", api); window.desktopAPI = api;`,
			},
			{
				code: "unresolved-helper-channel",
				preload: `import { contextBridge, ipcRenderer } from "electron"; function unused(channel) { ipcRenderer.on(channel, handler); } const api = {}; contextBridge.exposeInMainWorld("desktopAPI", api); window.desktopAPI = api;`,
			},
			{
				code: "global-mismatch",
				preload: `import { contextBridge } from "electron"; const api = {}; contextBridge.exposeInMainWorld("desktopAPI", api); window.otherAPI = api;`,
			},
			{
				code: "computed-ipc-access",
				preload: `import { contextBridge, ipcRenderer } from "electron"; const method = "invoke"; const api = { x: () => ipcRenderer[method]("x") }; contextBridge.exposeInMainWorld("desktopAPI", api); window.desktopAPI = api;`,
			},
			{
				code: "ipcrenderer-alias",
				preload: `import { contextBridge, ipcRenderer } from "electron"; const alias = ipcRenderer; const api = {}; contextBridge.exposeInMainWorld("desktopAPI", api); window.desktopAPI = api;`,
			},
			{
				code: "ipcrenderer-alias",
				preload: `import { contextBridge, ipcRenderer } from "electron"; const { invoke } = ipcRenderer; const api = {}; contextBridge.exposeInMainWorld("desktopAPI", api); window.desktopAPI = api;`,
			},
			{
				code: "ipcrenderer-alias",
				preload: `import { contextBridge, ipcRenderer } from "electron"; consume(ipcRenderer); const api = {}; contextBridge.exposeInMainWorld("desktopAPI", api); window.desktopAPI = api;`,
			},
			{
				code: "no-exposed-globals",
				preload: `import { contextBridge, ipcRenderer } from "electron"; const api = {}; window.desktopAPI = api;`,
			},
			{
				code: "dynamic-global-name",
				preload: `import { contextBridge, ipcRenderer } from "electron"; const api = {}; contextBridge.exposeInMainWorld(globalName, api); window.desktopAPI = api;`,
			},
			{
				code: "parse-error",
				preload: `import { contextBridge, ipcRenderer } from "electron"; const api = { x: () => ipcRenderer.invoke("broken") ; contextBridge.exposeInMainWorld("desktopAPI", api); window.desktopAPI = api;`,
			},
			{
				code: "parse-error",
				preload: `import { contextBridge, ipcRenderer } from "electron"; import "../shared/bad"; const api = {}; contextBridge.exposeInMainWorld("desktopAPI", api); window.desktopAPI = api;`,
				files: { "apps/desktop/src/shared/bad.ts": `export const = "bad";` },
			},
		];

		for (const { code, preload, files } of cases) {
			const surface = extract(preload, { files });
			expect(surface.issues.map((issue) => issue.code), `${code}: ${preload}`).toContain(code);
		}
	});

	it("reports missing index.d.ts", () => {
		const surface = extract(basicPreload(`x: 1`), { declarations: null });
		expect(surface.issues.map(({ code }) => code)).toContain("missing-declarations");
	});

	it("sorts output deterministically when independent statements are shuffled", () => {
		const first = `import { contextBridge, ipcRenderer } from "electron";
const api = { z: () => ipcRenderer.send("z:channel"), a: () => ipcRenderer.invoke("a:channel") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;
`;
		const second = `import { contextBridge, ipcRenderer } from "electron";
const api = { a: () => ipcRenderer.invoke("a:channel"), z: () => ipcRenderer.send("z:channel") };
contextBridge.exposeInMainWorld("desktopAPI", api);
window.desktopAPI = api;
`;
		const left = extract(first);
		const right = extract(second);
		expect(entrySignature(left)).toEqual(entrySignature(right));
		expect(left.entries.map(({ channel }) => channel)).toEqual(["a:channel", "z:channel"]);
		expect(left.members).toEqual(right.members);
	});

	it("uses default read-only filesystem functions when omitted", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multica-preload-surface-"));
		try {
			const preloadPathOnDisk = path.join(tempRoot, preloadPath);
			const declarationsPathOnDisk = path.join(tempRoot, declarationsPath);
			fs.mkdirSync(path.dirname(preloadPathOnDisk), { recursive: true });
			fs.mkdirSync(path.dirname(declarationsPathOnDisk), { recursive: true });
			fs.writeFileSync(preloadPathOnDisk, basicPreload(`x: () => ipcRenderer.invoke("disk:channel")`));
			fs.writeFileSync(declarationsPathOnDisk, defaultDeclarations);
			const surface = extractPreloadSurface({ root: tempRoot });
			expect(surface.issues).toEqual([]);
			expect(surface.entries.map(({ channel }) => channel)).toEqual(["disk:channel"]);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
