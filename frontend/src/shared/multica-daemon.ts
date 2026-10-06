// Shapes Multica's renderer expects from `daemonAPI` (apps/desktop/src/shared/
// daemon-types.ts in the Multica repo) and the mapping from `multica daemon
// status --output json`. Pure, so it is unit-testable.

export type DaemonState = "running" | "stopped" | "starting" | "stopping" | "cli_not_found";

export type DaemonStatus = {
	state: DaemonState;
	pid?: number;
	uptime?: string;
	daemonId?: string;
	deviceName?: string;
	agents?: string[];
	workspaceCount?: number;
	profile?: string;
	serverUrl?: string;
};

export type LocalRuntimeProbe =
	| {
			probeResult: "success";
			runtimeCount: number;
			providerSummary: Record<string, number>;
			onlineCount: number;
			offlineCount: number;
	  }
	| { probeResult: "error" };

const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const str = (value: unknown, max = 256): string | undefined =>
	typeof value === "string" && value.length <= max ? value : undefined;

/**
 * Maps the CLI's status JSON to the renderer's shape. Anything that is not a
 * running or starting daemon (empty output, errors, garbage) is "stopped"; the
 * caller reports "cli_not_found" itself when there is no binary.
 */
export function mapDaemonStatus(stdout: string): DaemonStatus {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { state: "stopped" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "stopped" };
	const raw = parsed as Record<string, unknown>;
	if (raw.status !== "running" && raw.status !== "starting") return { state: "stopped" };
	const agents = Array.isArray(raw.agents)
		? raw.agents.filter((agent): agent is string => typeof agent === "string" && PROVIDER.test(agent.toLowerCase())).slice(0, 64)
		: undefined;
	const status: DaemonStatus = { state: raw.status };
	if (typeof raw.pid === "number" && Number.isSafeInteger(raw.pid)) status.pid = raw.pid;
	const fields: Array<[keyof DaemonStatus, unknown]> = [
		["uptime", raw.uptime],
		["daemonId", raw.daemon_id],
		["deviceName", raw.device_name],
		["profile", raw.profile],
		["serverUrl", raw.server_url],
	];
	for (const [key, value] of fields) {
		const text = str(value);
		if (text !== undefined) (status as Record<string, unknown>)[key] = text;
	}
	if (agents) status.agents = agents;
	if (Array.isArray(raw.workspaces)) status.workspaceCount = raw.workspaces.length;
	return status;
}

/** What a running daemon reports about its runtimes; there is nothing to probe when it is not running. */
export function probeFromStatus(status: DaemonStatus): LocalRuntimeProbe {
	if (status.state !== "running") return { probeResult: "error" };
	const providerSummary: Record<string, number> = {};
	for (const agent of status.agents ?? []) {
		const provider = agent.trim().toLowerCase();
		providerSummary[provider] = (providerSummary[provider] ?? 0) + 1;
	}
	const runtimeCount = Object.values(providerSummary).reduce((sum, count) => sum + count, 0);
	return { probeResult: "success", runtimeCount, providerSummary, onlineCount: runtimeCount, offlineCount: 0 };
}

/** Change detection for pushed status. Uptime is included so the renderer's display keeps moving. */
export function daemonStatusKey(status: DaemonStatus): string {
	return JSON.stringify(status);
}
