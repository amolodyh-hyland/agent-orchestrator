import path from "node:path";
import {
	EMPTY_LOCAL_SERVER_STATUS,
	localServerAvailability,
	localServerStatusKey,
	type LocalServerErrorCode,
	type LocalServerLogsResult,
	type LocalServerResult,
	type LocalServerService,
	type LocalServerState,
	type LocalServerStatus,
} from "../shared/multica-local-server";
import { DEFAULT_MULTICA_SETTINGS, type MulticaCheckResult, type MulticaSettings } from "../shared/multica";
import {
	COMPOSE_FILE_NAME,
	composeListCommand,
	composeVersionCommand,
	dockerVersionCommand,
	findDockerBinary,
	findLocalDockerEndpoint,
	localServerChildEnv,
	trustedPathDirs,
	logsCommand,
	openDockerCommand,
	psCommand,
	restartCommand,
	runLocalServerCommand,
	stopCommand,
	upCommand,
	type CommandResult,
	type CommandSpec,
	type ExecFileLike,
	type StackPaths,
} from "./multica-local-server-commands";
import { ENV_FILE_NAME, type LocalServerSettings, type SetupOutcome, type StackCheck } from "./multica-local-server-stack";
import {
	classifyDockerError,
	deriveLocalServerState,
	isComposeMissing,
	isPortConflict,
	parseComposeList,
	parseComposePs,
	probeOutcomeFromCheck,
	publishedWebPort,
	redactCommandText,
	type ContainerInfo,
	type DeriveInput,
	type DockerProbe,
	type ProbeOutcome,
} from "./multica-local-server-state";

// Starts, stops and restarts the self-hosted Multica SERVER (Docker Compose) and reports
// its status. Commands come only from multica-local-server-commands, one operation runs
// at a time on this machine, and nothing read from the stack (.env, log lines) is kept
// or written anywhere by AO.

const DEFAULT_POLL_MS = 5_000;
const DOCKER_WAIT_MS = 120_000;
const DOCKER_WAIT_POLL_MS = 2_000;
const LOG_LINE_MAX = 2_000;

// One stack operation per machine, across every service instance (as the daemon CLI service does).
let operationBusy = false;

export type MulticaLocalServer = {
	getStatus: () => Promise<LocalServerStatus>;
	/** Starts or stops the background status poll; nothing runs until the Settings block is shown. */
	watch: (enabled: boolean) => void;
	start: () => Promise<LocalServerResult>;
	stop: () => Promise<LocalServerResult>;
	restart: () => Promise<LocalServerResult>;
	cancel: () => LocalServerResult;
	setup: () => Promise<LocalServerResult>;
	chooseFolder: () => Promise<LocalServerResult>;
	useDetectedFolder: () => Promise<LocalServerResult>;
	getLogs: (service: LocalServerService, tail: number) => Promise<LocalServerLogsResult>;
	dispose: () => void;
};

export type MulticaLocalServerOptions = {
	readServerSettings: () => Promise<MulticaSettings>;
	readStackSettings: () => Promise<LocalServerSettings>;
	writeStackSettings: (settings: LocalServerSettings) => Promise<unknown>;
	validate: (dir: string) => Promise<StackCheck>;
	fileExists: (file: string) => Promise<boolean>;
	setupEnv: (stack: StackPaths) => Promise<SetupOutcome>;
	probe: (request: { customUrl: string; apiUrl: string }) => Promise<MulticaCheckResult>;
	/** Opens the native folder dialog; null when cancelled. */
	chooseFolder: () => Promise<string | null>;
	exec: ExecFileLike;
	emit: (status: LocalServerStatus) => void;
	home: string;
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	findDocker?: () => string | null;
	/** Trusted directories for the child's PATH; defaults to the verified install roots. */
	findPathDirs?: () => string[];
	/** The local engine's address (`unix://…`); defaults to a search of the usual local sockets. */
	findEndpoint?: () => string | null;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	pollMs?: number;
	dockerWaitMs?: number;
	dockerWaitPollMs?: number;
};

type Folder = { kind: "none" } | { kind: "invalid"; dir: string } | { kind: "ok"; stack: StackPaths };
type Prepared = { ok: true; stack: StackPaths; docker: string } | { ok: false; code: LocalServerErrorCode; detail?: string };

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

export function createMulticaLocalServer(options: MulticaLocalServerOptions): MulticaLocalServer {
	const clock = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const canLaunchDocker = options.platform === "darwin";
	const findEndpoint =
		options.findEndpoint ?? (() => findLocalDockerEndpoint({ home: options.home, platform: options.platform, uid: typeof process.getuid === "function" ? process.getuid() : undefined }));
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
	const findDocker = options.findDocker ?? (() => findDockerBinary({ home: options.home, platform: options.platform, uid, gid }));
	const findPathDirs = options.findPathDirs ?? (() => trustedPathDirs({ home: options.home, platform: options.platform, uid, gid }));

	let disposed = false;
	let watching = false;
	let timer: NodeJS.Timeout | undefined;
	let refreshing: Promise<LocalServerStatus> | undefined;
	let currentOp: LocalServerState | null = null;
	let controller: AbortController | undefined;
	let lastError: LocalServerStatus["error"] = null;
	let portFailure = false;
	let unreadyAt: number | null = null;
	// True while .env is being created: past that point the operation is not cancellable.
	let setupWriting = false;
	let lastStatus: LocalServerStatus = { ...EMPTY_LOCAL_SERVER_STATUS, canLaunchDocker };
	let lastKey = "";

	// Every engine command runs against the local endpoint found now, or not at all: with no
	// local engine listening it reports "not running" instead of reaching for any other one.
	const run = async (spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult> => {
		const endpoint = findEndpoint();
		if (spec.engine && endpoint === null) {
			return { error: Object.assign(new Error("no local Docker engine endpoint"), { code: "NO_LOCAL_ENGINE" }), stdout: "", stderr: "" };
		}
		return runLocalServerCommand(options.exec, spec, localServerChildEnv(options.env, options.home, options.platform, endpoint, findPathDirs()), signal);
	};

	const publish = (status: LocalServerStatus): void => {
		lastStatus = status;
		const key = localServerStatusKey(status);
		if (disposed || key === lastKey) return;
		lastKey = key;
		options.emit(status);
	};

	const readSettings = (): Promise<MulticaSettings> => options.readServerSettings().catch(() => ({ ...DEFAULT_MULTICA_SETTINGS }));

	async function resolveFolder(): Promise<Folder> {
		const saved = (await options.readStackSettings().catch(() => ({ stackDir: "" }))).stackDir;
		if (saved !== "") {
			const check = await options.validate(saved);
			return check.ok ? { kind: "ok", stack: { dir: check.dir, file: check.file } } : { kind: "invalid", dir: saved };
		}
		const check = await options.validate(path.join(options.home, ".multica", "server"));
		return check.ok ? { kind: "ok", stack: { dir: check.dir, file: check.file } } : { kind: "none" };
	}

	async function inspectEngine(docker: string | null, signal?: AbortSignal): Promise<{ state: DockerProbe; detail?: string }> {
		if (!docker) return { state: "not_installed" };
		const result = await run(dockerVersionCommand(docker), signal);
		const state = classifyDockerError(result.error, result.stderr);
		return state === "unknown" ? { state, detail: redactCommandText(result.stderr || result.error?.message || "") } : { state };
	}
	const engineState = async (docker: string | null, signal?: AbortSignal): Promise<DockerProbe> => (await inspectEngine(docker, signal)).state;

	async function composeInstalled(docker: string): Promise<boolean> {
		const result = await run(composeVersionCommand(docker));
		return !(result.error && isComposeMissing(result.stderr));
	}

	/** A Multica stack Docker already knows about, offered to the user; null when none or not valid. */
	async function detectFolder(docker: string, current: string | null): Promise<string | null> {
		const result = await run(composeListCommand(docker));
		if (result.error) return null;
		const projects = parseComposeList(result.stdout) ?? [];
		for (const project of projects) {
			if (project.name !== "multica") continue;
			const file = project.configFiles.find((candidate) => path.isAbsolute(candidate) && path.basename(candidate) === COMPOSE_FILE_NAME);
			if (!file) continue;
			const check = await options.validate(path.dirname(file));
			if (check.ok && check.dir !== current) return check.dir;
		}
		return null;
	}

	async function computeStatus(): Promise<LocalServerStatus> {
		const base: LocalServerStatus = { ...EMPTY_LOCAL_SERVER_STATUS, canLaunchDocker };
		const settings = await readSettings();
		const availability = localServerAvailability(settings);
		if (!availability.available) {
			unreadyAt = null;
			return { ...base, state: "unavailable", unavailableReason: availability.reason };
		}
		const folder = await resolveFolder();
		const docker = findDocker();
		const inspectedEngine = await inspectEngine(docker);
		const engine = inspectedEngine.state;
		let inspectFailure: LocalServerStatus["error"] = engine === "unknown" ? { code: "inspect_failed", ...(inspectedEngine.detail ? { detail: inspectedEngine.detail } : {}) } : null;
		let inspected = true;
		const installed = engine === "ok" && docker ? await composeInstalled(docker) : true;

		let hasEnv = false;
		let containers: ContainerInfo[] = [];
		let probe: ProbeOutcome = "unknown";
		let detectedFolder: string | null = null;
		// The .env check is a plain file check, so it does not need Docker to be up.
		if (folder.kind === "ok") hasEnv = await options.fileExists(path.join(folder.stack.dir, ENV_FILE_NAME));
		if (engine === "ok" && docker && installed) {
			if (folder.kind === "ok") {
				if (hasEnv) {
					const ps = await run(psCommand(docker, folder.stack));
					const parsed = ps.error ? null : parseComposePs(ps.stdout);
					if (parsed === null) {
						// Neither an error nor unreadable output says the stack is stopped.
						inspected = false;
						inspectFailure = { code: "inspect_failed", detail: ps.error ? redactCommandText(ps.stderr || ps.error.message) : "Unexpected output from docker compose ps" };
					} else {
						containers = parsed;
					}
					if (inspected) probe = probeOutcomeFromCheck(await options.probe({ customUrl: availability.webUrl, apiUrl: availability.apiUrl }));
				}
			} else {
				detectedFolder = await detectFolder(docker, folder.kind === "invalid" ? folder.dir : null);
			}
		}

		const now = clock();
		const input: DeriveInput = {
			op: null,
			folder: folder.kind,
			hasEnv,
			docker: engine,
			composeInstalled: installed,
			containers,
			inspected,
			probe,
			unreadyForMs: unreadyAt === null ? 0 : now - unreadyAt,
			portFailure,
		};
		const state = deriveLocalServerState(input);
		// The grace clock runs for any stack that is up or being created, so a stack that never gets past "created" still turns unhealthy.
		const present = containers.some((container) => container.state === "running" || container.state === "created");
		unreadyAt = (state === "starting" || state === "unhealthy") && present ? (unreadyAt ?? now) : null;
		if (state === "healthy") portFailure = false;

		const published = publishedWebPort(containers);
		return {
			...base,
			state,
			folder: folder.kind === "ok" ? folder.stack.dir : folder.kind === "invalid" ? folder.dir : null,
			detectedFolder,
			portMismatch: published !== null && published !== availability.webPort ? { published, configured: availability.webPort } : null,
			error: inspectFailure ?? lastError,
		};
	}

	const refresh = (): Promise<LocalServerStatus> => {
		if (currentOp) return Promise.resolve({ ...lastStatus, state: currentOp, error: null });
		if (refreshing) return refreshing;
		const pending: Promise<LocalServerStatus> = computeStatus()
			.then((status) => (currentOp ? { ...lastStatus, state: currentOp, error: null } : status))
			.catch(() => lastStatus)
			.finally(() => {
				if (refreshing === pending) refreshing = undefined;
			});
		refreshing = pending;
		return pending;
	};

	const refreshAndPublish = async (): Promise<LocalServerStatus> => {
		const status = await refresh();
		publish(status);
		return status;
	};

	const setOp = (state: LocalServerState): void => {
		currentOp = state;
		publish({ ...lastStatus, state, error: null });
	};

	async function operate(state: LocalServerState, work: (signal: AbortSignal) => Promise<LocalServerResult>): Promise<LocalServerResult> {
		if (operationBusy) return { ok: false, code: "busy" };
		operationBusy = true;
		const own = new AbortController();
		controller = own;
		setOp(state);
		let result: LocalServerResult;
		try {
			result = await work(own.signal);
		} catch {
			result = { ok: false, code: "command_failed" };
		} finally {
			operationBusy = false;
			currentOp = null;
			controller = undefined;
		}
		lastError = result.ok || result.code === "cancelled" ? null : { code: result.code, ...(result.detail ? { detail: result.detail } : {}) };
		refreshing = undefined;
		await refreshAndPublish();
		return result;
	}

	async function prepare(): Promise<Prepared> {
		const availability = localServerAvailability(await readSettings());
		if (!availability.available) return { ok: false, code: "unavailable" };
		const folder = await resolveFolder();
		if (folder.kind === "none") return { ok: false, code: "no_folder" };
		if (folder.kind === "invalid") return { ok: false, code: "invalid_folder" };
		if (!(await options.fileExists(path.join(folder.stack.dir, ENV_FILE_NAME)))) return { ok: false, code: "needs_setup" };
		const docker = findDocker();
		if (!docker) return { ok: false, code: "docker_not_installed" };
		return { ok: true, stack: folder.stack, docker };
	}

	function outcome(result: CommandResult, signal: AbortSignal): LocalServerResult {
		if (!result.error) return { ok: true };
		if (signal.aborted) return { ok: false, code: "cancelled" };
		if (result.error.killed) return { ok: false, code: "timeout" };
		const text = result.stderr || result.error.message;
		if (isPortConflict(text)) {
			portFailure = true;
			return { ok: false, code: "port_conflict", detail: redactCommandText(text) };
		}
		return { ok: false, code: "command_failed", detail: redactCommandText(text) };
	}

	async function waitForDocker(docker: string, signal: AbortSignal): Promise<"ok" | "timeout" | "cancelled"> {
		const deadline = clock() + (options.dockerWaitMs ?? DOCKER_WAIT_MS);
		for (;;) {
			if (signal.aborted) return "cancelled";
			if ((await engineState(docker, signal)) === "ok") return "ok";
			if (signal.aborted) return "cancelled";
			if (clock() >= deadline) return "timeout";
			await sleep(options.dockerWaitPollMs ?? DOCKER_WAIT_POLL_MS, signal);
		}
	}

	/** Makes sure Docker's engine answers; on macOS a stopped Docker Desktop is started and waited for. */
	async function ensureEngine(docker: string, signal: AbortSignal, mayLaunch: boolean): Promise<LocalServerResult> {
		const inspected = await inspectEngine(docker, signal);
		// Cancelled while Docker was being asked: do not go on to launch Docker Desktop.
		if (signal.aborted) return { ok: false, code: "cancelled" };
		if (inspected.state === "ok") return { ok: true };
		if (inspected.state === "unknown") return { ok: false, code: "inspect_failed", ...(inspected.detail ? { detail: inspected.detail } : {}) };
		if (!mayLaunch || !canLaunchDocker) return { ok: false, code: "docker_not_running" };
		setOp("docker_starting");
		const opened = await run(openDockerCommand(), signal);
		if (opened.error) return signal.aborted ? { ok: false, code: "cancelled" } : { ok: false, code: "command_failed", detail: redactCommandText(opened.stderr || opened.error.message) };
		const waited = await waitForDocker(docker, signal);
		if (waited === "cancelled") return { ok: false, code: "cancelled" };
		if (waited === "timeout") return { ok: false, code: "docker_start_timeout" };
		return { ok: true };
	}

	async function stackCommand(
		state: LocalServerState,
		build: (docker: string, stack: StackPaths) => CommandSpec,
		mayLaunchDocker: boolean,
	): Promise<LocalServerResult> {
		return operate(state, async (signal) => {
			const prepared = await prepare();
			if (signal.aborted) return { ok: false, code: "cancelled" };
			if (!prepared.ok) return prepared;
			const engine = await ensureEngine(prepared.docker, signal, mayLaunchDocker);
			if (!engine.ok) return engine;
			const installed = await composeInstalled(prepared.docker);
			if (signal.aborted) return { ok: false, code: "cancelled" };
			if (!installed) return { ok: false, code: "compose_missing" };
			setOp(state);
			const result = outcome(await run(build(prepared.docker, prepared.stack), signal), signal);
			if (result.ok) portFailure = false;
			return result;
		});
	}

	async function saveFolder(dir: string): Promise<LocalServerResult> {
		const check = await options.validate(dir);
		if (!check.ok) return { ok: false, code: "invalid_folder", detail: check.error };
		await options.writeStackSettings({ stackDir: check.dir });
		lastError = null;
		await refreshAndPublish();
		return { ok: true };
	}

	return {
		getStatus: refreshAndPublish,
		watch: (enabled) => {
			if (disposed) return;
			if (!enabled) {
				watching = false;
				if (timer) clearInterval(timer);
				timer = undefined;
				return;
			}
			if (watching) {
				void refreshAndPublish();
				return;
			}
			watching = true;
			void refreshAndPublish();
			timer = setInterval(() => void refreshAndPublish(), options.pollMs ?? DEFAULT_POLL_MS);
			timer.unref?.();
		},
		start: () => stackCommand("starting_server", upCommand, true),
		stop: () => stackCommand("stopping", stopCommand, false),
		restart: () => stackCommand("restarting", restartCommand, false),
		cancel: () => {
			// Creating .env is one quick write that cannot be taken back half-way: once it has started, cancel says so.
			if (setupWriting) return { ok: false, code: "busy" };
			controller?.abort();
			return { ok: true };
		},
		setup: () =>
			operate("setting_up", async (signal) => {
				const availability = localServerAvailability(await readSettings());
				if (signal.aborted) return { ok: false, code: "cancelled" };
				if (!availability.available) return { ok: false, code: "unavailable" };
				const folder = await resolveFolder();
				if (signal.aborted) return { ok: false, code: "cancelled" };
				if (folder.kind === "none") return { ok: false, code: "no_folder" };
				if (folder.kind === "invalid") return { ok: false, code: "invalid_folder" };
				const exists = await options.fileExists(path.join(folder.stack.dir, ENV_FILE_NAME));
				if (signal.aborted) return { ok: false, code: "cancelled" };
				if (exists) return { ok: false, code: "already_set_up" };
				// Last chance to cancel: from here the file is written (exclusively, in one step) or not at all.
				setupWriting = true;
				try {
					const created = await options.setupEnv(folder.stack);
					if (created === "created") return { ok: true };
					return { ok: false, code: created === "already_set_up" ? "already_set_up" : "setup_failed" };
				} finally {
					setupWriting = false;
				}
			}),
		chooseFolder: async () => {
			if (operationBusy) return { ok: false, code: "busy" };
			if (!localServerAvailability(await readSettings()).available) return { ok: false, code: "unavailable" };
			const dir = await options.chooseFolder();
			if (dir === null) return { ok: false, code: "cancelled" };
			return saveFolder(dir);
		},
		useDetectedFolder: async () => {
			if (operationBusy) return { ok: false, code: "busy" };
			if (!localServerAvailability(await readSettings()).available) return { ok: false, code: "unavailable" };
			const docker = findDocker();
			if (!docker) return { ok: false, code: "docker_not_installed" };
			const folder = await resolveFolder();
			const detected = await detectFolder(docker, folder.kind === "ok" ? folder.stack.dir : folder.kind === "invalid" ? folder.dir : null);
			if (!detected) return { ok: false, code: "no_detected_folder" };
			return saveFolder(detected);
		},
		getLogs: async (service, tail) => {
			const prepared = await prepare();
			if (!prepared.ok) return prepared;
			const engine = await inspectEngine(prepared.docker);
			if (engine.state === "unknown") return { ok: false, code: "inspect_failed", ...(engine.detail ? { detail: engine.detail } : {}) };
			if (engine.state !== "ok") return { ok: false, code: "docker_not_running" };
			const result = await run(logsCommand(prepared.docker, prepared.stack, service, tail));
			if (result.error) {
				if (result.error.killed) return { ok: false, code: "timeout" };
				return { ok: false, code: "command_failed", detail: redactCommandText(result.stderr || result.error.message) };
			}
			// Shown to the user as they are (a sign-in code is how they log in without email), kept nowhere.
			const lines = result.stdout
				.replace(/\r/g, "")
				.split("\n")
				.filter((line) => line.length > 0)
				.slice(-tail)
				.map((line) => line.slice(0, LOG_LINE_MAX));
			return { ok: true, lines };
		},
		dispose: () => {
			disposed = true;
			watching = false;
			if (timer) clearInterval(timer);
			timer = undefined;
			controller?.abort();
		},
	};
}
