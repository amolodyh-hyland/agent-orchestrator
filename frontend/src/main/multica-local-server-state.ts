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
		if (Array.isArray(whole)) {
			// An element that is not an object makes the whole output unusable; it is not dropped.
			const records = whole.map(asRecord);
			return records.every((entry): entry is Record<string, unknown> => entry !== null) ? records : null;
		}
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

const CONTAINER_STATES = new Set(["created", "running", "paused", "restarting", "removing", "exited", "dead"]);
const SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function validPort(value: unknown): boolean {
	return value === undefined || value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535);
}

function parseContainer(record: Record<string, unknown>): ContainerInfo | null {
	const { Service: service, State: state, Health: health, ExitCode: exitCode, Publishers: publishers } = record;
	// Service and State are what every decision rests on: without a usable value the output is not Compose's.
	if (typeof service !== "string" || !SERVICE_PATTERN.test(service)) return null;
	if (typeof state !== "string" || !CONTAINER_STATES.has(state.toLowerCase())) return null;
	if (health !== undefined && health !== null && typeof health !== "string") return null;
	if (exitCode !== undefined && exitCode !== null && !(typeof exitCode === "number" && Number.isInteger(exitCode))) return null;
	if (publishers !== undefined && publishers !== null && !Array.isArray(publishers)) return null;
	const ports: number[] = [];
	for (const entry of publishers ?? []) {
		const publisher = asRecord(entry);
		if (!publisher || !validPort(publisher.PublishedPort) || !validPort(publisher.TargetPort)) return null;
		if (typeof publisher.PublishedPort === "number" && publisher.PublishedPort > 0) ports.push(publisher.PublishedPort);
	}
	return {
		service,
		state: state.toLowerCase(),
		health: typeof health === "string" ? health.toLowerCase() : "",
		exitCode: typeof exitCode === "number" ? exitCode : 0,
		publishedPorts: ports,
	};
}

/**
 * Containers of the stack, or null when the output is not Compose's JSON: any record without a
 * usable Service and State (or with a field of the wrong type) rejects the whole inspection,
 * so output of an unexpected shape can never read as "no containers".
 */
export function parseComposePs(stdout: string): ContainerInfo[] | null {
	const records = parseJsonRecords(stdout);
	if (!records) return null;
	const containers: ContainerInfo[] = [];
	for (const record of records) {
		const container = parseContainer(record);
		if (!container) return null;
		containers.push(container);
	}
	return containers;
}

export type ComposeProject = { name: string; status: string; configFiles: string[] };

/** `docker compose ls --all --format json`; null when a record has no usable Name or a field of the wrong type. */
export function parseComposeList(stdout: string): ComposeProject[] | null {
	const records = parseJsonRecords(stdout);
	if (!records) return null;
	const projects: ComposeProject[] = [];
	for (const record of records) {
		const { Name: name, Status: status, ConfigFiles: files } = record;
		if (typeof name !== "string" || name === "") return null;
		if (status !== undefined && status !== null && typeof status !== "string") return null;
		if (files !== undefined && files !== null && typeof files !== "string") return null;
		projects.push({
			name,
			status: typeof status === "string" ? status : "",
			configFiles: typeof files === "string" ? files.split(",").map((file) => file.trim()).filter(Boolean) : [],
		});
	}
	return projects;
}

/** The published host port of the web service, which Settings' URL should match. */
export function publishedWebPort(containers: ContainerInfo[]): number | null {
	return containers.find((container) => container.service === "frontend")?.publishedPorts[0] ?? null;
}

/** `unknown`: Docker answered in a way that proves nothing about whether the engine runs (for example permission denied). */
export type DockerProbe = "ok" | "not_installed" | "untrusted" | "not_running" | "unknown";

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
	// Found, but where other users can modify it: reported as such, never run.
	if (input.docker === "untrusted") return "docker_untrusted";
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
