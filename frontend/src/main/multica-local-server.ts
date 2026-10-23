import path from "node:path";
import { acquireLocalServerProjectLock, type LocalServerProjectLock } from "./multica-local-server-lock";
import { mutationApprovalDigest, projectMatchesMutation, resolveMutationPlan, type ProjectMutationPlan } from "./multica-local-server-verification";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hasProjectConflict, inspectMulticaProject, resolveProjectTargets, snapshotDigest, verifyRecoveryReceipt, type ProjectApproval, type ProjectApprovalRequest, type ProjectSnapshot, type ProjectTargets } from "./multica-local-server-preflight";
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
	stopContainersCommand,
	composeVersionCommand,
	dockerVersionCommand,
	composePluginStillTrusted,
	findComposePlugin,
	findDockerBinary,
	identifyComposePlugin,
	inspectComposePlugin,
	inspectDockerBinary,
	findLocalDockerEndpoint,
	localServerChildEnv,
	trustedPathDirs,
	logsCommand,
	psCommand,
	restartCommand,
	runLocalServerCommand,
	stopCommand,
	upCommand,
	type CommandResult,
	type CommandSpec,
	type ComposePluginIdentity,
	type ExecFileLike,
	type StackPaths,
} from "./multica-local-server-commands";
import { ensureLocalDockerConfig, type DockerConfigResult } from "./multica-local-server-docker-config";
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

export type ProjectLogRequest = { stackDir: string; snapshot: ProjectSnapshot; digest: string; service: LocalServerService; tail: number };

export type MulticaLocalServerOptions = {
	acquireProjectLock?: () => Promise<LocalServerProjectLock | null>;
	approveProjectLogs?: (request: ProjectLogRequest) => Promise<boolean>;
	readProjectTargets?: (stack: StackPaths) => Promise<ProjectTargets>;
	approveProjectMutation?: (request: ProjectApprovalRequest) => Promise<ProjectApproval | null>;
	verifyRecovery?: (file: string, digest: string) => Promise<void>;
	stackIdentity?: (stack: StackPaths) => Promise<string>;
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
	/** AO's own folder used as HOME (and DOCKER_CONFIG's parent) for every Docker command, under its state dir. */
	dockerHomeDir: string;
	/** True when a docker CLI exists in a usual install location but fails the ownership/permission check. */
	isDockerUntrusted?: () => boolean;
	/** True when a Compose plugin exists in a usual install location but fails the ownership/permission check. */
	isComposeUntrusted?: () => boolean;
	/** The Compose plugin binary in a trusted location; defaults to a search of the usual install paths. */
	findComposePlugin?: () => ComposePluginIdentity | null;
	/** Re-checks a verified plugin identity right before a Compose command is spawned; defaults to a file-system check. */
	isComposePluginStillTrusted?: (identity: ComposePluginIdentity) => boolean;
	/** Prepares AO's Docker home so Docker only loads the validated Compose plugin; defaults to the file-system implementation. */
	ensureDockerConfig?: (pluginDir: string | null) => Promise<DockerConfigResult>;
	/** The local engine's address (`unix://…`); defaults to a search of the usual local sockets. */
	findEndpoint?: () => string | null;
	now?: () => number;
	pollMs?: number;
};

type Folder = { kind: "none" } | { kind: "invalid"; dir: string } | { kind: "ok"; stack: StackPaths };
type Prepared = { ok: true; stack: StackPaths; docker: string } | { ok: false; code: LocalServerErrorCode; detail?: string };

export function createMulticaLocalServer(options: MulticaLocalServerOptions): MulticaLocalServer {
	const clock = options.now ?? Date.now;
	const canLaunchDocker = false;
	const acquireProjectLock = options.acquireProjectLock ?? (() => acquireLocalServerProjectLock(options.dockerHomeDir));
	const readTargets = options.readProjectTargets ?? (async (stack: StackPaths) => resolveProjectTargets(await readFile(stack.file, "utf8")));
	const findEndpoint =
		options.findEndpoint ?? (() => findLocalDockerEndpoint({ home: options.home, platform: options.platform, uid: typeof process.getuid === "function" ? process.getuid() : undefined }));
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
	const findDocker = options.findDocker ?? (() => findDockerBinary({ home: options.home, platform: options.platform, uid, gid }));
	const dockerUntrusted = options.isDockerUntrusted ?? (() => inspectDockerBinary({ home: options.home, platform: options.platform, uid, gid }).untrusted);
	const composeUntrusted = options.isComposeUntrusted ?? (() => inspectComposePlugin({ home: options.home, platform: options.platform, uid, gid }).untrusted);
	const locateComposePlugin =
		options.findComposePlugin ??
		((): ComposePluginIdentity | null => {
			const found = findComposePlugin({ home: options.home, platform: options.platform, uid, gid });
			return found === null ? null : identifyComposePlugin(found);
		});
	const pluginStillTrusted = options.isComposePluginStillTrusted ?? ((identity: ComposePluginIdentity) => composePluginStillTrusted(identity, { uid, gid }));
	const ensureDockerConfig = options.ensureDockerConfig ?? ((pluginDir: string | null) => ensureLocalDockerConfig({ root: options.dockerHomeDir, pluginDir, uid }));
	const findPathDirs = options.findPathDirs ?? (() => trustedPathDirs({ home: options.home, platform: options.platform, uid, gid }));

	let verifiedOwner: { snapshot: string; targetIdentity: string; stackDir: string; startPlan?: string } | null = null;
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
	const run = async (spec: CommandSpec, signal?: AbortSignal, pinnedEndpoint?: string): Promise<CommandResult> => {
		const endpoint = findEndpoint();
		if (pinnedEndpoint !== undefined && endpoint !== pinnedEndpoint) return { error: new Error("selected engine changed"), stdout: "", stderr: "selected engine changed" };
		if (spec.engine && endpoint === null) {
			return { error: Object.assign(new Error("no local Docker engine endpoint"), { code: "NO_LOCAL_ENGINE" }), stdout: "", stderr: "" };
		}
		// HOME and DOCKER_CONFIG are AO's own, listing only the Compose plugin validated just now. What is carried
		// from here to the spawn is the plugin's identity (not a "found" flag): the runner re-checks it right before it spawns.
		const plugin = locateComposePlugin();
		// Every Compose command is refused here when no trusted plugin is found right now (Docker would fall back to its system plugin directories).
		if (spec.compose && plugin === null) {
			return { error: Object.assign(new Error("no trusted Docker Compose plugin"), { code: "NO_TRUSTED_COMPOSE" }), stdout: "", stderr: "" };
		}
		const config = spec.docker ? await ensureDockerConfig(plugin === null ? null : path.dirname(plugin.path)) : null;
		if (config !== null && !config.ok) {
			return { error: Object.assign(new Error("AO's Docker settings folder is not safe to use"), { code: "UNTRUSTED_DOCKER_CONFIG" }), stdout: "", stderr: "AO's Docker settings folder is not safe to use" };
		}
		// A refusal by the runner (or an endpoint that is not local) becomes a failed result like any other, never a rejection that escapes to a caller.
		try {
			return await runLocalServerCommand(options.exec, spec, localServerChildEnv(options.env, options.home, options.platform, endpoint, findPathDirs(), config === null ? null : config.home), spec.compose && plugin !== null ? { identity: plugin, stillTrusted: pluginStillTrusted } : null, signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : "command refused";
			// Only the Compose-plugin refusal keeps its own code; any other refusal is "refused", with its message as the
			// text, so it can never be read as "Docker is not running" (which would launch Docker Desktop).
			const code = (error as { code?: unknown } | null)?.code === "NO_TRUSTED_COMPOSE" ? "NO_TRUSTED_COMPOSE" : "COMMAND_REFUSED";
			return { error: Object.assign(new Error(message), { code }), stdout: "", stderr: message };
		}
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
		if (!docker) return { state: dockerUntrusted() ? "untrusted" : "not_installed" };
		const result = await run(dockerVersionCommand(docker), signal);
		const state = classifyDockerError(result.error, result.stderr);
		return state === "unknown" ? { state, detail: redactCommandText(result.stderr || result.error?.message || "") } : { state };
	}

	async function composeInstalled(docker: string): Promise<boolean> {
		// No Compose plugin in a trusted location counts as no Compose: nothing else is ever loaded.
		if (locateComposePlugin() === null) return false;
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
			// A Compose plugin that exists but is not trusted is the same finding as an untrusted docker.
			docker: engine === "ok" && !installed && composeUntrusted() ? "untrusted" : engine,
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
		if (!docker) return { ok: false, code: dockerUntrusted() ? "docker_untrusted" : "docker_not_installed" };
		return { ok: true, stack: folder.stack, docker };
	}

	/** The reason no Compose command can run right now, or null when a trusted plugin is there. */
	function composeProblem(): LocalServerErrorCode | null {
		return locateComposePlugin() !== null ? null : composeUntrusted() ? "docker_untrusted" : "compose_missing";
	}

	function outcome(result: CommandResult, signal: AbortSignal): LocalServerResult {
		if (!result.error) return { ok: true };
		if (signal.aborted) return { ok: false, code: "cancelled" };
		if (result.error.code === "NO_TRUSTED_COMPOSE") return { ok: false, code: composeProblem() ?? "compose_missing" };
		if (result.error.killed) return { ok: false, code: "timeout" };
		const text = result.stderr || result.error.message;
		if (isPortConflict(text)) {
			portFailure = true;
			return { ok: false, code: "port_conflict", detail: redactCommandText(text) };
		}
		return { ok: false, code: "command_failed", detail: redactCommandText(text) };
	}

	async function ensureEngine(docker: string, signal: AbortSignal): Promise<LocalServerResult> {
		const inspected = await inspectEngine(docker, signal);
		if (signal.aborted) return { ok: false, code: "cancelled" };
		if (inspected.state === "ok") return { ok: true };
		if (inspected.state === "unknown") return { ok: false, code: "inspect_failed", ...(inspected.detail ? { detail: inspected.detail } : {}) };
		return { ok: false, code: "docker_not_running", detail: "Start Docker separately with explicit approval: engine startup can resume existing services. Then retry the project preflight." };
	}

	async function stopUnverifiedProject(docker: string, endpoint: string, targets: ProjectTargets, authority: ProjectSnapshot): Promise<string> {
		const authorizedIds = new Set(authority.containers.map((container) => container.id));
		const unapproved = new Set<string>();
		const reportUnapproved = () => unapproved.size > 0 ? ` Unapproved containers were not stopped: ${[...unapproved].sort().join(", ")}. They may still be running; explicit approval is required.` : "";
		try {
			const inspect = () => inspectMulticaProject(endpoint, docker, (spec) => run(spec, undefined, endpoint), targets);
			const current = await inspect();
			if (current.engineId !== authority.engineId) throw new Error("Safety stop engine changed");
			for (const container of current.containers) if (!authorizedIds.has(container.id)) unapproved.add(container.id);
			const ids = current.containers.filter((container) => authorizedIds.has(container.id)).map((container) => container.id);
			if (ids.length > 0 && (await run(stopContainersCommand(docker, ids), undefined, endpoint)).error) throw new Error("Safety stop failed");
			const stopped = await inspect();
			if (stopped.engineId !== authority.engineId) throw new Error("Safety stop engine changed");
			for (const container of stopped.containers) if (!authorizedIds.has(container.id)) unapproved.add(container.id);
			if (stopped.containers.some((c) => authorizedIds.has(c.id) && !["exited", "created", "dead"].includes(c.state))) throw new Error("Stop not verified");
			return `${ids.length > 0 ? "Authorized containers are stopped." : "No currently observed container IDs have established stop authority; no containers were stopped."}${reportUnapproved()} Data was not rolled back; inspect the project and use the approved restore procedure if needed.`;
		} catch {
			return `Safety stop could not be verified. Inspect the selected engine immediately; containers may still be running. No unapproved container IDs were stopped.${reportUnapproved()} Data was not rolled back.`;
		}
	}

	async function stackCommand(
		state: LocalServerState,
		build: (docker: string, stack: StackPaths) => CommandSpec,
		action: ProjectApprovalRequest["action"],
	): Promise<LocalServerResult> {
		return operate(state, async (signal) => {
			let lock: LocalServerProjectLock | null;
			try { lock = await acquireProjectLock(); } catch { return { ok: false, code: "command_failed", detail: "The local server project lock is unsafe or unavailable; nothing was changed." }; }
			if (!lock) return { ok: false, code: "busy", detail: "Another local server operation owns the project lock. A retained crash lock requires operator recovery." };
			try {
				const prepared = await prepare();
				if (signal.aborted) return { ok: false, code: "cancelled" };
				if (!prepared.ok) return prepared;
				const engine = await ensureEngine(prepared.docker, signal);
				if (!engine.ok) return engine;
				const installed = await composeInstalled(prepared.docker);
				if (signal.aborted) return { ok: false, code: "cancelled" };
				if (!installed) return { ok: false, code: composeUntrusted() ? "docker_untrusted" : "compose_missing" };
				const fresh = await prepare();
				if (signal.aborted) return { ok: false, code: "cancelled" };
				if (!fresh.ok) return fresh;
				const endpoint = findEndpoint();
				if (!endpoint) return { ok: false, code: "inspect_failed" };
				const identity = options.stackIdentity ?? (async (stack: StackPaths) => createHash("sha256").update(await readFile(stack.file)).update(await readFile(path.join(stack.dir, ENV_FILE_NAME))).digest("hex"));
				const targetIdentity = await identity(fresh.stack);
				let before: ProjectSnapshot;
				let plan: ProjectMutationPlan;
				let targets: ProjectTargets;
				try {
					targets = await readTargets(fresh.stack);
					before = await inspectMulticaProject(endpoint, fresh.docker, (spec) => run(spec, signal, endpoint), targets);
					plan = await resolveMutationPlan(action, before, targets, fresh.docker, fresh.stack, (spec) => run(spec, signal, endpoint));
					const digest = mutationApprovalDigest(before, plan, targetIdentity, action, fresh.stack);
					const owned = verifiedOwner?.snapshot === snapshotDigest(before) && verifiedOwner.targetIdentity === targetIdentity && verifiedOwner.stackDir === fresh.stack.dir && (action !== "start" || verifiedOwner.startPlan === JSON.stringify(plan));
					if (hasProjectConflict(before) && !owned) {
						if (!options.approveProjectMutation) return { ok: false, code: "command_failed", detail: "Existing multica project requires explicit takeover and downtime approval with recovery evidence." };
						const approvalStarted = clock();
						const approval = await options.approveProjectMutation({ action, stackDir: fresh.stack.dir, snapshot: before, digest, plan });
						if (signal.aborted || !approval || approval.digest !== digest || approval.action !== action) return { ok: false, code: "cancelled" };
						await (options.verifyRecovery ?? verifyRecoveryReceipt)(approval.recoveryReceipt, digest);
						if (clock() - approvalStarted > 5 * 60_000) return { ok: false, code: "cancelled" };
					}
					const final = await prepare();
					if (!final.ok) return final;
					const current = await inspectMulticaProject(endpoint, fresh.docker, (spec) => run(spec, signal, endpoint), targets);
					if (final.docker !== fresh.docker || final.stack.dir !== fresh.stack.dir || await identity(final.stack) !== targetIdentity || snapshotDigest(current) !== snapshotDigest(before) ||
						JSON.stringify(await resolveMutationPlan(action, before, targets, fresh.docker, fresh.stack, (spec) => run(spec, signal, endpoint))) !== JSON.stringify(plan)) return { ok: false, code: "inspect_failed", detail: "Stack, images or project changed; inspect and approve again." };
				} catch {
					if (signal.aborted) return { ok: false, code: "cancelled" };
					const problem = composeProblem();
					if (problem) return { ok: false, code: problem };
					return { ok: false, code: "inspect_failed", detail: "Project ownership, images or protected recovery evidence could not be verified. Images must be built or pulled separately." };
				}
				if (signal.aborted) return { ok: false, code: "cancelled" };
				setOp(state);
				const result = outcome(await run(build(fresh.docker, fresh.stack), signal, endpoint), signal);
				try {
					const after = await inspectMulticaProject(endpoint, fresh.docker, (spec) => run(spec, undefined, endpoint), targets);
					if (!projectMatchesMutation(action, before, after, targets, plan, fresh.stack)) {
						if (!result.ok && snapshotDigest(after) === snapshotDigest(before)) return result;
						throw new Error("Post-mutation identities do not match approval");
					}
					if (await identity(fresh.stack) !== targetIdentity) throw new Error("Configuration changed during mutation");
					if (result.ok) {
						const previousStartPlan = verifiedOwner?.snapshot === snapshotDigest(before) && verifiedOwner.targetIdentity === targetIdentity && verifiedOwner.stackDir === fresh.stack.dir ? verifiedOwner.startPlan : undefined;
						verifiedOwner = { snapshot: snapshotDigest(after), targetIdentity, stackDir: fresh.stack.dir, startPlan: action === "start" ? JSON.stringify(plan) : previousStartPlan };
					}
				} catch {
					verifiedOwner = null;
					const stopped = await stopUnverifiedProject(fresh.docker, endpoint, targets, before);
					return { ok: false, code: "inspect_failed", detail: `Post-mutation verification failed: concurrent external activity or unexpected identities. ${stopped}` };
				}
				if (result.ok) portFailure = false;
				return result;
			} finally {
				await lock.release();
			}
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
		start: () => stackCommand("starting_server", upCommand, "start"),
		stop: () => stackCommand("stopping", stopCommand, "stop"),
		restart: () => stackCommand("restarting", restartCommand, "restart"),
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
			if (!docker) return { ok: false, code: dockerUntrusted() ? "docker_untrusted" : "docker_not_installed" };
			const problem = composeProblem();
			if (problem) return { ok: false, code: problem };
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
			const problem = composeProblem();
			if (problem) return { ok: false, code: problem };
			const endpoint = findEndpoint();
			if (!endpoint) return { ok: false, code: "inspect_failed" };
			let digest: string;
			const targets = await readTargets(prepared.stack).catch(() => null);
			if (!targets) return { ok: false, code: "inspect_failed" };
			const inspect = () => inspectMulticaProject(endpoint, prepared.docker, (command) => run(command, undefined, endpoint), targets);
			try {
				const snapshot = await inspect();
				digest = snapshotDigest(snapshot);
				if (!options.approveProjectLogs || !await options.approveProjectLogs({ stackDir: prepared.stack.dir, snapshot, digest, service, tail })) return { ok: false, code: "cancelled" };
				if (snapshotDigest(await inspect()) !== digest) return { ok: false, code: "inspect_failed" };
			} catch {
				return { ok: false, code: "inspect_failed" };
			}
			const result = await run(logsCommand(prepared.docker, prepared.stack, service, tail), undefined, endpoint);
			if (result.error) {
				if (result.error.code === "NO_TRUSTED_COMPOSE") return { ok: false, code: composeProblem() ?? "compose_missing" };
				if (result.error.killed) return { ok: false, code: "timeout" };
				return { ok: false, code: "command_failed", detail: redactCommandText(result.stderr || result.error.message) };
			}
			try {
				if (snapshotDigest(await inspect()) !== digest) return { ok: false, code: "inspect_failed" };
			} catch {
				return { ok: false, code: "inspect_failed" };
			}
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
