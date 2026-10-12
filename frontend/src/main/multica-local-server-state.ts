import type { LocalServerState } from "../shared/multica-local-server";

// Pure helpers: parse Docker's JSON, classify its errors, redact its text, and derive
// the status the Settings block shows. No I/O here, so every state is table-tested
// from fake docker output.

export const EXPECTED_SERVICES = ["postgres", "backend", "frontend"] as const;
/** How long a stack that is running but not answering yet is still "starting". */
export const STARTING_GRACE_MS = 90_000;

export type ContainerInfo = {
	service: string;
	state: string;
	health: string;
	exitCode: number;
	publishedPorts: number[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** `docker compose ... --format json` prints NDJSON (newer Compose) or a JSON array (older). */
function parseJsonRecords(stdout: string): Record<string, unknown>[] | null {
	const text = stdout.trim();
	if (text === "") return [];
	try {
		const whole: unknown = JSON.parse(text);
		if (Array.isArray(whole)) return whole.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null);
		const single = asRecord(whole);
		return single ? [single] : null;
	} catch {
		const records: Record<string, unknown>[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			try {
				const record = asRecord(JSON.parse(line));
				if (!record) return null;
				records.push(record);
			} catch {
				return null;
			}
		}
		return records;
	}
}

/** Containers of the stack, or null when the output is not Compose's JSON. */
export function parseComposePs(stdout: string): ContainerInfo[] | null {
	const records = parseJsonRecords(stdout);
	if (!records) return null;
	return records.map((record) => {
		const publishers = Array.isArray(record.Publishers) ? record.Publishers : [];
		return {
			service: typeof record.Service === "string" ? record.Service : "",
			state: typeof record.State === "string" ? record.State.toLowerCase() : "",
			health: typeof record.Health === "string" ? record.Health.toLowerCase() : "",
			exitCode: typeof record.ExitCode === "number" ? record.ExitCode : 0,
			publishedPorts: publishers
				.map((entry) => asRecord(entry)?.PublishedPort)
				.filter((port): port is number => typeof port === "number" && port > 0),
		};
	});
}

export type ComposeProject = { name: string; status: string; configFiles: string[] };

/** `docker compose ls --all --format json`. */
export function parseComposeList(stdout: string): ComposeProject[] | null {
	const records = parseJsonRecords(stdout);
	if (!records) return null;
	return records.map((record) => ({
		name: typeof record.Name === "string" ? record.Name : "",
		status: typeof record.Status === "string" ? record.Status : "",
		configFiles:
			typeof record.ConfigFiles === "string"
				? record.ConfigFiles.split(",").map((file) => file.trim()).filter(Boolean)
				: [],
	}));
}

/** The published host port of the web service, which Settings' URL should match. */
export function publishedWebPort(containers: ContainerInfo[]): number | null {
	return containers.find((container) => container.service === "frontend")?.publishedPorts[0] ?? null;
}

/** `unknown`: Docker answered in a way that proves nothing about whether the engine runs (for example permission denied). */
export type DockerProbe = "ok" | "not_installed" | "not_running" | "unknown";

const ENGINE_DOWN = /cannot connect|can't connect|connection refused|is the docker daemon running|error during connect|failed to connect|no such file or directory|dial unix|docker desktop is (?:stopped|starting)/i;
const ACCESS_DENIED = /permission denied|access is denied|operation not permitted/i;

/**
 * Distinguishes "no docker" from "the engine is not running" from "the answer proves
 * nothing". Only a recognized connection failure counts as a stopped engine: any other
 * error (permission denied on the socket, an unexpected message) is `unknown`, because a
 * failed inspection is not evidence that nothing is running.
 */
export function classifyDockerError(error: { code?: string | number | null } | null, stderr = ""): DockerProbe {
	if (!error) return "ok";
	if (error.code === "ENOENT") return "not_installed";
	if (error.code === "NO_LOCAL_ENGINE") return "not_running";
	if (ACCESS_DENIED.test(stderr)) return "unknown";
	if (ENGINE_DOWN.test(stderr)) return "not_running";
	return stderr.trim() === "" ? "not_running" : "unknown";
}

export function isComposeMissing(stderr: string): boolean {
	return /'compose' is not a docker command|unknown shorthand flag|is not a docker command/i.test(stderr);
}

export function isPortConflict(text: string): boolean {
	return /port is already allocated|address already in use|ports are not available|bind: .*in use/i.test(text);
}

const SECRET_KEY = "[A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|KEY|JWT|CREDENTIAL)[A-Za-z0-9_]*";

/** Reduces command output to something safe to show: secret-looking assignments and URL credentials removed, last 400 characters. */
export function redactCommandText(text: string): string {
	const cleaned = text
		.replace(new RegExp(`(${SECRET_KEY})\\s*[=:]\\s*("[^"]*"|'[^']*'|\\S+)`, "gi"), "$1=[redacted]")
		.replace(/(\w+:\/\/)[^/\s:@]*:[^/\s@]*@/g, "$1[redacted]@")
		.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
		.trim();
	return cleaned.length > 400 ? cleaned.slice(-400) : cleaned;
}

export type ProbeOutcome = "ok" | "not_ready" | "other_listener" | "unreachable" | "unknown";

export type DeriveInput = {
	op: Extract<LocalServerState, "setting_up" | "starting_server" | "stopping" | "restarting" | "docker_starting"> | null;
	folder: "none" | "invalid" | "ok";
	hasEnv: boolean;
	docker: DockerProbe;
	composeInstalled: boolean;
	containers: ContainerInfo[];
	/** `docker compose ps` ran and its output was understood. False means the stack was not inspected. */
	inspected: boolean;
	probe: ProbeOutcome;
	/** How long the stack has been running without answering; 0 when it was just seen. */
	unreadyForMs: number;
	/** The last start failed because a port was taken. */
	portFailure: boolean;
};

const DEAD_STATES = new Set(["exited", "dead", "restarting", "paused", "removing"]);

/** The status the block shows, from facts only; see the design doc for the table. */
export function deriveLocalServerState(input: DeriveInput): LocalServerState {
	if (input.op) return input.op;
	if (input.docker === "not_installed") return "docker_not_installed";
	if (input.docker === "unknown") return "unknown";
	if (!input.composeInstalled && input.docker === "ok") return "compose_missing";
	if (input.folder === "none") return input.docker === "not_running" ? "docker_not_running" : "no_folder";
	if (input.folder === "invalid") return "invalid_folder";
	if (!input.hasEnv) return "needs_setup";
	if (input.docker === "not_running") return "docker_not_running";
	// A failed inspection is not proof of a stopped stack: say so instead of offering Start.
	if (!input.inspected) return "unknown";

	const running = input.containers.filter((container) => container.state === "running");
	if (running.length === 0 && !input.containers.some((container) => container.state === "created")) {
		if (input.probe === "ok" || input.probe === "not_ready") return "running_elsewhere";
		if (input.probe === "other_listener" || input.portFailure) return "port_conflict";
		return "stopped";
	}

	const hasFailed = input.containers.some((container) => DEAD_STATES.has(container.state) || container.health === "unhealthy");
	if (hasFailed) return "unhealthy";
	const starting = input.containers.some((container) => container.state === "created" || container.health === "starting");
	const allUp = EXPECTED_SERVICES.every((service) => running.some((container) => container.service === service));
	if (allUp && !starting && input.probe === "ok") return "healthy";
	return input.unreadyForMs < STARTING_GRACE_MS ? "starting" : "unhealthy";
}

/** Maps the checker's result onto what the state table needs. */
export function probeOutcomeFromCheck(result: { ok: true } | { ok: false; error: string }): ProbeOutcome {
	if (result.ok) return "ok";
	switch (result.error) {
		case "not_ready":
			return "not_ready";
		case "unreachable":
			return "unreachable";
		case "not_multica":
		case "timeout":
		case "tls":
			return "other_listener";
		default:
			return "unknown";
	}
}
