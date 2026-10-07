// @vitest-environment node
import { describe, expect, it } from "vitest";
import { daemonStatusKey, mapDaemonStatus, probeFromStatus } from "./multica-daemon";

const RUNNING = `{
  "active_task_count": 0,
  "agents": ["claude", "codex"],
  "cli_version": "v0.5.1",
  "daemon_id": "daemon-123",
  "device_name": "dev-box",
  "failed_terminal_report_bytes": 0,
  "failed_terminal_report_count": 0,
  "launched_by": "desktop",
  "os": "darwin",
  "pending_terminal_report_bytes": 0,
  "pending_terminal_report_count": 0,
  "pid": 94028,
  "profile": "",
  "resource_wait_task_count": 0,
  "running_task_count": 0,
  "server_url": "http://localhost:3000",
  "status": "running",
  "uptime": "1h0m0s",
  "workspaces": [{"id":"workspace-1","runtimes":["runtime-1","runtime-2"]}]
}`;

const STARTING = `{
  "active_task_count": 0,
  "agents": [],
  "cli_version": "v0.5.1",
  "daemon_id": "daemon-123",
  "device_name": "dev-box",
  "failed_terminal_report_bytes": 0,
  "failed_terminal_report_count": 0,
  "os": "darwin",
  "pending_terminal_report_bytes": 0,
  "pending_terminal_report_count": 0,
  "pid": 94028,
  "profile": "",
  "resource_wait_task_count": 0,
  "running_task_count": 0,
  "server_url": "http://localhost:3000",
  "status": "starting",
  "uptime": "2s",
  "workspaces": null
}`;

const STOPPED = `{
  "status": "stopped"
}`;

describe("mapDaemonStatus", () => {
	it.each([
		[
			"running health output",
			RUNNING,
			{
				state: "running",
				pid: 94028,
				uptime: "1h0m0s",
				daemonId: "daemon-123",
				deviceName: "dev-box",
				profile: "",
				serverUrl: "http://localhost:3000",
				agents: ["claude", "codex"],
				workspaceCount: 1,
			},
		],
		[
			"starting health output",
			STARTING,
			{
				state: "starting",
				pid: 94028,
				uptime: "2s",
				daemonId: "daemon-123",
				deviceName: "dev-box",
				profile: "",
				serverUrl: "http://localhost:3000",
				agents: [],
			},
		],
		["stopped CLI output", STOPPED, { state: "stopped" }],
		[
			"unknown and malformed fields",
			'{"status":"running","future_field":{"value":true},"pid":"94028","uptime":5,"daemon_id":null,"device_name":3,"agents":["claude",5,"Bad Name!"],"workspaces":"one"}',
			{ state: "running", agents: ["claude"] },
		],
	] as const)("maps %s", (_name, stdout, expected) => {
		expect(mapDaemonStatus(stdout)).toEqual(expected);
	});

	it.each(["", "not json", "[]", "null", "{", '{"status":"stopped"}'])("maps empty or non-live output %j to stopped", (stdout) => {
		expect(mapDaemonStatus(stdout)).toEqual({ state: "stopped" });
	});
});

describe("probeFromStatus", () => {
	it("reports every listed agent online and none offline", () => {
		expect(probeFromStatus(mapDaemonStatus(RUNNING))).toEqual({
			probeResult: "success",
			runtimeCount: 2,
			providerSummary: { claude: 1, codex: 1 },
			onlineCount: 2,
			offlineCount: 0,
		});
		expect(probeFromStatus({ state: "stopped" })).toEqual({ probeResult: "error" });
	});
});

describe("daemonStatusKey", () => {
	it("includes external ownership in change detection", () => {
		expect(daemonStatusKey({ state: "running", externallyManaged: false })).not.toBe(daemonStatusKey({ state: "running", externallyManaged: true }));
	});
});
