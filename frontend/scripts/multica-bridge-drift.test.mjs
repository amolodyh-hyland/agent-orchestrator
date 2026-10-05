// @vitest-environment node
import { describe, expect, it } from "vitest";
import { countDifferences, diffBridge, formatReport } from "./multica-bridge-drift.mjs";

const file = "apps/desktop/src/preload/index.ts";
const entry = (api, channel, kind = "invoke", line = 10) => ({
	api,
	channel,
	kind,
	direction: kind === "on" ? "inbound" : "outbound",
	file,
	line,
});
const surface = (entries, overrides = {}) => ({
	root: "/repo/multica",
	preloadFile: file,
	globals: [],
	entries,
	members: {},
	declaredMembers: {},
	issues: [],
	...overrides,
});
const inventory = (served = {}, issues = []) => ({ served, allowlist: Object.keys(served), issues });
const baseline = (entries = [], overrides = {}) => ({
	multicaCommit: "base123",
	preload: file,
	globals: [],
	members: {},
	entries: entries.map(({ api, channel, kind }) => ({ api, channel, kind })),
	...overrides,
});
const meta = {
	multicaRoot: "/repo/multica",
	multicaCommit: "abcdef012345",
	baselineCommit: "123456789",
	preloadFile: file,
	servedCount: 39,
};

describe("diffBridge", () => {
	it("matches the outbound surface and baseline", () => {
		const entries = [entry("desktopAPI.open", "window:open")];
		const report = diffBridge({
			surface: surface(entries),
			inventory: inventory({ "window:open": "invoke" }),
			baseline: baseline(entries),
		});

		expect(report.ok).toBe(true);
		expect(report.added).toEqual([]);
		expect(report.removed).toEqual([]);
		expect(report.changed).toEqual([]);
		expect(report.renamed).toEqual([]);
		expect(report.inbound).toEqual({ added: [], removed: [], renamed: [] });
		expect(formatReport(report, meta).split("\n")[0]).toBe("multica bridge drift check: PASS");
	});

	it("reports an outbound channel missing from AO", () => {
		const report = diffBridge({
			surface: surface([entry("desktopAPI.open", "window:open", "invoke", 27)]),
			inventory: inventory(),
			baseline: null,
		});

		expect(report.added).toEqual([
			{ channel: "window:open", kind: "invoke", api: "desktopAPI.open", file, line: 27 },
		]);
		expect(report.ok).toBe(false);
	});

	it("reports an AO channel that no outbound preload entry uses", () => {
		const report = diffBridge({
			surface: surface([]),
			inventory: inventory({ "window:open": "invoke" }),
			baseline: baseline(),
		});

		expect(report.removed).toEqual([{ channel: "window:open", aoKind: "invoke" }]);
	});

	it("pairs an unambiguous rename with a baseline and reports both sides without one", () => {
		const before = [entry("desktopAPI.open", "window:open")];
		const after = [entry("desktopAPI.open", "window:open-external", "invoke", 27)];
		const withBaseline = diffBridge({
			surface: surface(after),
			inventory: inventory({ "window:open": "invoke" }),
			baseline: baseline(before),
		});
		expect(withBaseline.renamed).toEqual([
			{
				api: "desktopAPI.open",
				kind: "invoke",
				from: "window:open",
				to: "window:open-external",
				file,
				line: 27,
			},
		]);
		expect(withBaseline.added).toEqual([]);
		expect(withBaseline.removed).toEqual([]);

		const withoutBaseline = diffBridge({
			surface: surface(after),
			inventory: inventory({ "window:open": "invoke" }),
			baseline: null,
		});
		expect(withoutBaseline.added).toHaveLength(1);
		expect(withoutBaseline.removed).toEqual([{ channel: "window:open", aoKind: "invoke" }]);
		expect(withoutBaseline.notes).toContain(
			"no baseline: renames are reported as one added and one removed channel",
		);
	});

	it("keeps ambiguous same-API rename candidates as additions and removals", () => {
		const before = [
			entry("desktopAPI.open", "window:open"),
			entry("desktopAPI.open", "window:open-old"),
		];
		const after = [
			entry("desktopAPI.open", "window:open-new-a"),
			entry("desktopAPI.open", "window:open-new-b", "invoke", 11),
		];
		const report = diffBridge({
			surface: surface(after),
			inventory: inventory({ "window:open": "invoke", "window:open-old": "invoke" }),
			baseline: baseline(before),
		});

		expect(report.renamed).toEqual([]);
		expect(report.added).toHaveLength(2);
		expect(report.removed).toHaveLength(2);
	});

	it("applies invoke, send, and sendSync compatibility rules", () => {
		const entries = [
			entry("api.invokeMatches", "invoke:ok", "invoke"),
			entry("api.sendMatchesAsync", "send:async", "send"),
			entry("api.sendMatchesSync", "send:sync-compatible", "send"),
			entry("api.syncMatches", "sendSync:ok", "sendSync"),
			entry("api.invokeMismatch", "invoke:mismatch", "invoke"),
			entry("api.sendMismatch", "send:mismatch", "send"),
			entry("api.syncMismatch", "sendSync:mismatch", "sendSync"),
		];
		const report = diffBridge({
			surface: surface(entries),
			inventory: inventory({
				"invoke:ok": "invoke",
				"send:async": "send",
				"send:sync-compatible": "sendSync",
				"sendSync:ok": "sendSync",
				"invoke:mismatch": "send",
				"send:mismatch": "invoke",
				"sendSync:mismatch": "send",
			}),
			baseline: baseline(entries),
		});

		expect(report.changed.map(({ channel }) => channel)).toEqual([
			"invoke:mismatch",
			"send:mismatch",
			"sendSync:mismatch",
		]);
		expect(report.added).toEqual([]);
		expect(report.removed).toEqual([]);
	});

	it("treats postMessage and sendToHost as unsupported kinds", () => {
		const entries = [
			entry("api.postMessage", "message:served", "postMessage"),
			entry("api.sendToHost", "host:missing", "sendToHost", 11),
		];
		const report = diffBridge({
			surface: surface(entries),
			inventory: inventory({ "message:served": "send" }),
			baseline: baseline(entries),
		});

		expect(report.added).toEqual([
			{ channel: "host:missing", kind: "sendToHost", api: "api.sendToHost", file, line: 11 },
		]);
		expect(report.changed).toEqual([
			{
				channel: "message:served",
				api: "api.postMessage",
				multicaKind: "postMessage",
				aoKind: "send",
				file,
				line: 10,
			},
		]);
	});

	it("reports inbound additions, removals, and an unambiguous rename", () => {
		const before = [
			entry("desktopAPI.oldListener", "event:removed", "on"),
			entry("desktopAPI.updatedListener", "event:old", "on"),
		];
		const after = [
			entry("desktopAPI.addedListener", "event:added", "on", 21),
			entry("desktopAPI.updatedListener", "event:new", "on", 22),
		];
		const report = diffBridge({
			surface: surface(after),
			inventory: inventory(),
			baseline: baseline(before),
		});

		expect(report.inbound).toEqual({
			added: [{ channel: "event:added", api: "desktopAPI.addedListener", file, line: 21 }],
			removed: [{ channel: "event:removed", api: "desktopAPI.oldListener" }],
			renamed: [
				{
					api: "desktopAPI.updatedListener",
					kind: "on",
					from: "event:old",
					to: "event:new",
					file,
					line: 22,
				},
			],
		});
		expect(report.ok).toBe(false);
	});

	it("reports inbound channel swaps as two API renames", () => {
		const before = [
			entry("desktopAPI.onAuth", "auth:token", "on"),
			entry("desktopAPI.onInvite", "invite:open", "on"),
		];
		const after = [
			entry("desktopAPI.onAuth", "invite:open", "on", 21),
			entry("desktopAPI.onInvite", "auth:token", "on", 22),
		];
		const report = diffBridge({
			surface: surface(after),
			inventory: inventory(),
			baseline: baseline(before),
		});

		expect(report.inbound).toEqual({
			added: [],
			removed: [],
			renamed: [
				{
					api: "desktopAPI.onInvite",
					kind: "on",
					from: "invite:open",
					to: "auth:token",
					file,
					line: 22,
				},
				{
					api: "desktopAPI.onAuth",
					kind: "on",
					from: "auth:token",
					to: "invite:open",
					file,
					line: 21,
				},
			],
		});
		expect(report.ok).toBe(false);
	});

	it("reports an inbound channel moved to another API as an addition and removal", () => {
		const report = diffBridge({
			surface: surface([entry("desktopAPI.onInvite", "auth:token", "on", 21)]),
			inventory: inventory(),
			baseline: baseline([entry("desktopAPI.onAuth", "auth:token", "on")]),
		});

		expect(report.inbound).toEqual({
			added: [{ channel: "auth:token", api: "desktopAPI.onInvite", file, line: 21 }],
			removed: [{ channel: "auth:token", api: "desktopAPI.onAuth" }],
			renamed: [],
		});
		expect(report.ok).toBe(false);
	});

	it("warns when outbound channels move between API members served by AO", () => {
		const before = [
			entry("desktopAPI.first", "channel:first"),
			entry("desktopAPI.second", "channel:second"),
		];
		const after = [
			entry("desktopAPI.first", "channel:second"),
			entry("desktopAPI.second", "channel:first"),
		];
		const report = diffBridge({
			surface: surface(after),
			inventory: inventory({ "channel:first": "invoke", "channel:second": "invoke" }),
			baseline: baseline(before),
		});

		expect(report.ok).toBe(true);
		expect(report.warnings.filter(({ code }) => code === "mapping-changed")).toEqual([
			{ code: "mapping-changed", message: "desktopAPI.first: channel:first -> channel:second" },
			{ code: "mapping-changed", message: "desktopAPI.second: channel:second -> channel:first" },
		]);
	});

	it("does not warn about an outbound mapping already reported as renamed", () => {
		const before = [entry("desktopAPI.open", "channel:old")];
		const report = diffBridge({
			surface: surface([entry("desktopAPI.open", "channel:new")]),
			inventory: inventory({ "channel:old": "invoke" }),
			baseline: baseline(before),
		});

		expect(report.renamed).toHaveLength(1);
		expect(report.warnings.filter(({ code }) => code === "mapping-changed")).toEqual([]);
	});

	it("does not compare inbound entries without a baseline", () => {
		const report = diffBridge({
			surface: surface([entry("desktopAPI.listener", "event:new", "on")]),
			inventory: inventory(),
			baseline: null,
		});

		expect(report.inbound).toEqual({ added: [], removed: [], renamed: [] });
		expect(report.notes).toEqual([
			"no baseline: inbound (main to renderer) channels were not compared",
		]);
	});

	it("reports every warning class and the up-to-date-bridge baseline note", () => {
		const entries = [entry("desktopAPI.open", "window:open")];
		const report = diffBridge({
			surface: surface(entries, {
				globals: ["newGlobal"],
				members: { desktopAPI: ["open", "runtimeOnly"] },
				declaredMembers: { desktopAPI: ["open", "typesOnly"] },
			}),
			inventory: inventory({ "window:open": "invoke" }, [
				{ code: "allowlist-mismatch", message: "allowlist differs from registered channels" },
				{ code: "probe-warning", message: "probe detail" },
			]),
			baseline: baseline(entries, {
				globals: ["oldGlobal"],
				members: { desktopAPI: ["open", "removed"] },
				entries: [{ api: "desktopAPI.previousName", channel: "window:open", kind: "invoke" }],
			}),
		});

		expect(report.ok).toBe(true);
		expect(report.warnings.map(({ code }) => code)).toEqual([
			"allowlist-mismatch",
			"declaration-mismatch",
			"globals-changed",
			"members-changed",
			"probe-warning",
		]);
		expect(report.warnings[0]).toEqual({
			code: "allowlist-mismatch",
			message: "allowlist differs from registered channels",
		});
		expect(report.notes).toContain(
			"baseline is behind the current preload; refresh it after the bridge is updated",
		);
	});

	it("counts all outbound and inbound differences", () => {
		const report = {
			added: [{}],
			removed: [{}],
			changed: [{}],
			renamed: [{}],
			inbound: { added: [{}], removed: [{}], renamed: [{}] },
		};
		expect(countDifferences(report)).toBe(7);
	});
});

describe("formatReport", () => {
	it("formats every section and uses the inbound-only fix hint when appropriate", () => {
		const report = {
			ok: false,
			added: [{ channel: "channel:add", kind: "invoke", api: "desktopAPI.add", file, line: 11 }],
			removed: [{ channel: "channel:remove", aoKind: "send" }],
			changed: [
				{
					channel: "channel:change",
					multicaKind: "invoke",
					aoKind: "send",
					api: "desktopAPI.change",
					file,
					line: 12,
				},
			],
			renamed: [
				{
					api: "desktopAPI.rename",
					kind: "sendSync",
					from: "channel:old",
					to: "channel:new",
					file,
					line: 13,
				},
			],
			inbound: {
				added: [{ channel: "event:add", api: "desktopAPI.onAdd", file, line: 14 }],
				removed: [{ channel: "event:remove", api: "desktopAPI.onRemove" }],
				renamed: [
					{
						api: "desktopAPI.onRename",
						kind: "on",
						from: "event:old",
						to: "event:new",
						file,
						line: 15,
					},
				],
			},
			warnings: [{ code: "allowlist-mismatch", message: "allowlist does not match" }],
			notes: ["baseline detail"],
		};

		expect(formatReport(report, meta)).toBe(
			`multica bridge drift check: FAIL (7 differences)
multica: /repo/multica @ abcdef0  preload: ${file}
baseline: 1234567   AO bridge: 39 channels served

ADDED   multica uses a channel AO does not serve (the jail blocks it)
  + invoke  "channel:add"  desktopAPI.add  ${file}:11

REMOVED   AO serves a channel multica no longer uses (stale allowlist entry)
  - send  "channel:remove"

CHANGED   same channel, different IPC kind
  ~ "channel:change"  multica invoke, AO serves send  desktopAPI.change  ${file}:12

RENAMED   same API member, new channel
  > sendSync  "channel:old" -> "channel:new"  desktopAPI.rename  ${file}:13

INBOUND (main to renderer) CHANGES SINCE THE BASELINE
  + "event:add"  desktopAPI.onAdd  ${file}:14    (added)
  - "event:remove"  desktopAPI.onRemove                   (removed)
  > "event:old" -> "event:new"  desktopAPI.onRename  ${file}:15    (renamed)

WARNINGS
  ! allowlist-mismatch: allowlist does not match

NOTES
  baseline detail

Update frontend/src/main/multica-desktop-bridge.ts (and the jail follows from multicaBridgeChannels()), then rerun. After the check passes, run "npm run check:multica-bridge -- --update-baseline" and commit the baseline with the submodule bump.
`,
		);

		const inboundOnly = {
			...report,
			added: [],
			removed: [],
			changed: [],
			renamed: [],
		};
		expect(formatReport(inboundOnly, meta).endsWith(
			'Decide whether AO delivers, stubs or ignores each inbound channel, then run "npm run check:multica-bridge -- --update-baseline" and commit the baseline.\n',
		)).toBe(true);
	});

	it("formats a clean report", () => {
		const report = {
			ok: true,
			added: [],
			removed: [],
			changed: [],
			renamed: [],
			inbound: { added: [], removed: [], renamed: [] },
			warnings: [],
			notes: [],
		};
		expect(formatReport(report, meta)).toBe(
			`multica bridge drift check: PASS
multica: /repo/multica @ abcdef0  preload: ${file}
baseline: 1234567   AO bridge: 39 channels served
`,
		);
	});

	it("is deterministic when surface, inventory, and baseline inputs are shuffled", () => {
		const entries = [
			entry("desktopAPI.rename", "old:channel"),
			entry("desktopAPI.add", "new:channel", "send", 12),
			entry("desktopAPI.listen", "event:new", "on", 13),
		];
		const before = [
			entry("desktopAPI.rename", "old:channel"),
			entry("desktopAPI.listen", "event:old", "on"),
		];
		const first = diffBridge({
			surface: surface(entries),
			inventory: inventory({ "old:channel": "invoke", "stale:channel": "send" }),
			baseline: baseline(before),
		});
		const second = diffBridge({
			surface: surface([...entries].reverse()),
			inventory: inventory({ "stale:channel": "send", "old:channel": "invoke" }),
			baseline: baseline([...before].reverse()),
		});

		expect(second).toEqual(first);
		expect(formatReport(second, meta)).toBe(formatReport(first, meta));
	});
});
