// One server's awareness: its credential, its read client, one watch per
// watched workspace, and the in-memory read model they feed. Everything here
// belongs to one `serverKey`; stopping the connection cancels every request,
// socket and timer, and drops the token from memory, so nothing carries over to
// another server or another credential.

import type { MulticaServer } from "../shared/multica";
import type { MulticaActionInput } from "../shared/multica-action-log";
import {
	MULTICA_ACTIVE_TASK_STATUSES,
	type AwarenessIssue,
	type AwarenessRun,
	type AwarenessWorkspaceState,
	type MulticaCredentialSource,
	type MulticaServerStatus,
	type MulticaWorkspaceWatchState,
} from "../shared/multica-awareness";
import type { MulticaCredentials } from "./multica-credentials";
import { createPageTransport, type PageHost } from "./multica-page-transport";
import {
	MAX_BACKOFF_MS,
	MIN_BACKOFF_MS,
	createFetchTransport,
	createMulticaReadClient,
	createReadBudget,
	systemScheduler,
	type FetchLike,
	type MulticaReadClient,
	type ReadFailureKind,
	type ReadResult,
	type Scheduler,
} from "./multica-read-client";
import {
	applyFrame,
	clearWorkspace,
	createServerModel,
	enforceCaps,
	isOfInterest,
	listItems,
	parseFrame,
	projectAgent,
	projectIssue,
	projectRun,
	projectRuntime,
	reconcileRuns,
	replaceAgents,
	replaceRuntimes,
	resolveUnknownOutcome,
	type FrameContext,
	type FrameEffect,
	type ParsedFrame,
	type ServerModel,
} from "./multica-read-model";
import { createWorkspaceSocket, reconnectDelayMs, type WorkspaceSocket, type WorkspaceSocketStop } from "./multica-ws-client";

export const RECONCILE_PAGE_SIZE = 100;
export const RECONCILE_MAX_PAGES = 3;
export const RECONCILE_LINKED_LIMIT = 20;
export const RECONCILE_UNKNOWN_OUTCOME_LIMIT = 10;
export const DEGRADED_RECONCILE_MS = 60_000;
export const SAFETY_RECONCILE_MS = 10 * 60_000;
export const ME_CHECK_MS = 15 * 60_000;
export const AGENT_REFRESH_DEBOUNCE_MS = 2_000;
export const MAX_BUFFERED_FRAMES = 1000;
export const PAGE_POLL_MS = 60_000;

export type KnownWorkspace = { id: string; slug: string; name: string };

export type ServerConnectionOptions = {
	server: MulticaServer;
	credentialSource: MulticaCredentialSource;
	consentGranted: boolean;
	credentials: MulticaCredentials;
	fetch: FetchLike;
	/** The embedded Multica view, for page-only mode. */
	pageHost: () => (PageHost & { activeServerKey: () => string | null; readActiveSlug: () => Promise<string | null> }) | undefined;
	/** Identifiers (upper case) of the issues an AO session is linked to, per workspace slug. */
	linkedIdentifiers: (workspaceSlug: string) => string[];
	/** Issue ids (version 2 links) an AO session is linked to on this server. */
	linkedIssueIds: () => ReadonlySet<string>;
	/** Called whenever the model or a state changed. The caller throttles. */
	onChange: () => void;
	/** Writes one action-log record; lifecycle lines only. */
	record: (input: MulticaActionInput) => void;
	/** Reports the workspace list the server returned, so the caller can persist names and slugs. Resolves once it is saved. */
	onWorkspaces: (workspaces: KnownWorkspace[]) => Promise<void>;
	/** Reads per minute and burst for this server; defaults to 60 and 10. */
	readBudget?: { perMinute: number; burst: number };
	scheduler?: Scheduler;
	random?: () => number;
};

export type ServerConnectionView = {
	status: MulticaServerStatus;
	meId: string | null;
	workspaces: AwarenessWorkspaceState[];
	model: ServerModel;
};

export type ServerConnection = {
	start: () => void;
	/** Cancels everything and forgets the token. The connection cannot be restarted; create a new one. */
	stop: () => void;
	/** Starts watches for these workspace ids and stops the others. */
	setWatched: (workspaceIds: readonly string[]) => void;
	refreshWorkspaces: () => Promise<void>;
	/** Links changed: re-read the issues AO sessions are linked to. */
	noteLinksChanged: () => void;
	view: () => ServerConnectionView;
	/** Every held issue with this identifier (it is unique per workspace, not per server). */
	lookupAll: (identifier: string) => Array<{ issue: AwarenessIssue; workspaceSlug: string; activeRuns: AwarenessRun[] }>;
};

type Watch = {
	workspaceId: string;
	state: MulticaWorkspaceWatchState;
	attempt: number;
	partial: boolean;
	transport: "socket" | "page";
	socket: WorkspaceSocket | null;
	reconciling: boolean;
	/** Bumped whenever a reconcile starts or the socket drops, so a stale reconcile stops writing. */
	reconcileSeq: number;
	buffer: ParsedFrame[];
	rerun: boolean;
	everLive: boolean;
	timers: { poll: unknown; safety: unknown; agents: unknown; snapshot: unknown };
	stopped: boolean;
};

type ReconcileOutcome = "ok" | "unauthorized" | "no_access" | "gone" | "failed";

/** Starts async work whose failure must not escape: every step already guards against a stopped connection. */
function fire(work: Promise<unknown>): void {
	work.catch(() => undefined);
}

export function createServerConnection(options: ServerConnectionOptions): ServerConnection {
	const { server } = options;
	const scheduler = options.scheduler ?? systemScheduler;
	const random = options.random ?? Math.random;
	const model = createServerModel();
	const known = new Map<string, KnownWorkspace>();
	const watches = new Map<string, Watch>();
	let epoch = 0;
	let started = false;
	let stopped = false;
	/** The credential works and the workspace list is loaded: watches may start and the status may read live. */
	let ready = false;
	let status: MulticaServerStatus = "connecting";
	let meId: string | null = null;
	let token: string | null = null;
	let client: MulticaReadClient | null = null;
	let startTimer: unknown = null;
	let meTimer: unknown = null;
	let startFailures = 0;
	let wantedWatched: string[] = [];
	const pageMode = options.credentialSource === "page";

	const nowIso = (): string => new Date(scheduler.now()).toISOString();
	const changed = (): void => {
		if (!stopped) options.onChange();
	};
	const slugOf = (workspaceId: string): string => known.get(workspaceId)?.slug ?? "";

	const setStatus = (next: MulticaServerStatus): void => {
		if (status === next) return;
		status = next;
		changed();
	};

	const lifecycle = (kind: "connect" | "disconnect" | "signed_out" | "error", workspaceId: string | undefined, ok: boolean, code?: string): void => {
		options.record({
			kind,
			direction: "local",
			actor: "system",
			serverKey: server.key,
			...(workspaceId !== undefined ? { workspaceId } : {}),
			result: { ok, ...(code ? { code } : {}) },
		});
	};

	const context = (workspaceId: string): FrameContext => ({
		workspaceId,
		nowIso: nowIso(),
		meId,
		isLinked: (issue) =>
			options.linkedIssueIds().has(issue.id) || options.linkedIdentifiers(slugOf(issue.workspaceId)).includes(issue.identifier.toUpperCase()),
	});

	// Credentials and client

	function buildClient(): MulticaReadClient | null {
		const budget = createReadBudget({ ...options.readBudget, scheduler });
		if (pageMode) {
			return createMulticaReadClient({
				budget,
				transport: createPageTransport({
					host: () => {
						const host = options.pageHost();
						return host && host.activeServerKey() === server.key ? host : undefined;
					},
					serverKey: server.key,
					apiOrigin: server.config.apiUrl,
					now: () => scheduler.now(),
				}),
			});
		}
		return createMulticaReadClient({
			budget,
			transport: createFetchTransport({
				apiOrigin: server.config.apiUrl,
				getToken: () => token,
				fetch: options.fetch,
				now: () => scheduler.now(),
			}),
		});
	}

	// Failures

	function signedOut(): void {
		if (stopped) return;
		epoch += 1;
		ready = false;
		// A refused token is not retried until the credential changes: no retry storm.
		for (const watch of watches.values()) stopWatch(watch, "idle");
		client?.dispose();
		client = null;
		token = null;
		clearTimer(meTimer);
		meTimer = null;
		clearTimer(startTimer);
		startTimer = null;
		setStatus("signed_out");
		lifecycle("signed_out", undefined, false, "unauthorized");
	}

	function clearTimer(handle: unknown): void {
		if (handle !== null) scheduler.clearTimeout(handle);
	}

	function failureKindIsOutage(kind: ReadFailureKind): boolean {
		return kind === "unreachable" || kind === "timeout" || kind === "server_error" || kind === "rate_limited" || kind === "bad_response" || kind === "redirect";
	}

	// Start

	async function begin(): Promise<void> {
		if (stopped) return;
		const myEpoch = epoch;
		ready = false;
		setStatus("connecting");
		if (pageMode) {
			const host = options.pageHost();
			if (!host || host.activeServerKey() !== server.key) {
				// The page shows another server, or is not loaded: wait and try again.
				setStatus("paused");
				scheduleStart(PAGE_POLL_MS);
				return;
			}
		} else {
			const resolved = await options.credentials.resolve(server, options.credentialSource, options.consentGranted);
			if (stopped || myEpoch !== epoch) return;
			if (!resolved.ok) {
				setStatus("no_credential");
				return;
			}
			token = resolved.token;
		}
		client = buildClient();
		const me = await client!.me();
		if (stopped || myEpoch !== epoch) return;
		if (!me.ok) {
			if (me.kind === "unauthorized") {
				if (pageMode) {
					setStatus("no_credential");
					scheduleStart(PAGE_POLL_MS);
					return;
				}
				signedOut();
				return;
			}
			startFailures += 1;
			setStatus(pageMode && me.kind === "unreachable" ? "paused" : "unreachable");
			if (failureKindIsOutage(me.kind) || me.kind === "forbidden" || me.kind === "not_found") scheduleStart(reconnectDelayMs(startFailures, random()) + MIN_BACKOFF_MS);
			return;
		}
		startFailures = 0;
		meId = readUserId(me);
		if (meId === null) {
			setStatus("unreachable");
			scheduleStart(MAX_BACKOFF_MS);
			return;
		}
		const listed = await loadWorkspaces(myEpoch);
		if (stopped || myEpoch !== epoch) return;
		if (!listed) {
			startFailures += 1;
			setStatus("unreachable");
			scheduleStart(reconnectDelayMs(startFailures, random()) + MIN_BACKOFF_MS);
			return;
		}
		ready = true;
		lifecycle("connect", undefined, true);
		applyWatched();
		scheduleMeCheck(myEpoch);
		refreshStatus();
	}

	function scheduleStart(delayMs: number): void {
		clearTimer(startTimer);
		startTimer = scheduler.setTimeout(() => {
			startTimer = null;
			fire(begin());
		}, delayMs);
	}

	function readUserId(result: ReadResult): string | null {
		if (!result.ok || !result.data || typeof result.data !== "object") return null;
		const id = (result.data as { id?: unknown }).id;
		return typeof id === "string" && id.length > 0 && id.length <= 80 ? id : null;
	}

	async function loadWorkspaces(myEpoch: number): Promise<boolean> {
		if (!client) return false;
		const result = await client.workspaces();
		if (stopped || myEpoch !== epoch) return false;
		if (!result.ok) {
			if (result.kind === "unauthorized" && !pageMode) signedOut();
			return false;
		}
		const list: KnownWorkspace[] = [];
		for (const raw of listItems(result.data, "workspaces")) {
			if (!raw || typeof raw !== "object") continue;
			const record = raw as Record<string, unknown>;
			if (typeof record.id !== "string" || typeof record.slug !== "string") continue;
			list.push({ id: record.id, slug: record.slug, name: typeof record.name === "string" ? record.name : record.slug });
		}
		known.clear();
		for (const workspace of list) known.set(workspace.id, workspace);
		await options.onWorkspaces(list).catch(() => undefined);
		if (stopped || myEpoch !== epoch) return false;
		changed();
		return true;
	}

	function scheduleMeCheck(myEpoch: number): void {
		clearTimer(meTimer);
		meTimer = scheduler.setTimeout(async () => {
			meTimer = null;
			if (stopped || myEpoch !== epoch || !client) return;
			const me = await client.me();
			if (stopped || myEpoch !== epoch) return;
			if (!me.ok && me.kind === "unauthorized" && !pageMode) {
				signedOut();
				return;
			}
			scheduleMeCheck(myEpoch);
		}, ME_CHECK_MS);
	}

	// Watches

	function refreshStatus(): void {
		if (stopped || !ready || status === "signed_out" || status === "no_credential" || status === "paused" || status === "unreachable" || status === "off") return;
		const active = [...watches.values()].filter((watch) => !watch.stopped && (watch.state !== "no_access" && watch.state !== "gone"));
		if (active.length === 0 || active.every((watch) => watch.state === "live")) setStatus("live");
		else if (active.some((watch) => watch.state === "live") || active.some((watch) => watch.everLive)) setStatus("degraded");
		else setStatus("connecting");
	}

	function setWatchState(watch: Watch, state: MulticaWorkspaceWatchState, attempt = watch.attempt): void {
		if (watch.state === state && watch.attempt === attempt) return;
		const wentLive = state === "live" && watch.state !== "live";
		watch.state = state;
		watch.attempt = attempt;
		if (wentLive) lifecycle("connect", watch.workspaceId, true);
		refreshStatus();
		changed();
	}

	function applyWatched(): void {
		if (stopped || !ready || !client || status === "signed_out" || status === "no_credential") return;
		const wanted = new Set(wantedWatched);
		for (const watch of [...watches.values()]) if (!wanted.has(watch.workspaceId)) stopWatch(watch, "idle");
		for (const workspaceId of wantedWatched) {
			const existing = watches.get(workspaceId);
			if (existing && !existing.stopped) continue;
			if (!known.has(workspaceId)) continue;
			startWatch(workspaceId);
		}
		refreshStatus();
	}

	function startWatch(workspaceId: string): void {
		const watch: Watch = {
			workspaceId,
			state: "connecting",
			attempt: 0,
			partial: false,
			transport: pageMode ? "page" : "socket",
			socket: null,
			reconciling: false,
			reconcileSeq: 0,
			buffer: [],
			rerun: false,
			everLive: false,
			timers: { poll: null, safety: null, agents: null, snapshot: null },
			stopped: false,
		};
		watches.set(workspaceId, watch);
		changed();
		if (pageMode) {
			fire(pollPage(watch));
			return;
		}
		watch.socket = createWorkspaceSocket({
			wsUrl: server.config.wsUrl,
			workspaceId,
			getToken: () => token,
			scheduler,
			random,
			onFrame: (raw) => handleFrame(watch, raw),
			onLive: () => {
				watch.everLive = true;
				fire(runReconcile(watch));
			},
			onState: (state, attempt) => {
				// A live socket is not a live workspace until the reconcile has read the server's truth.
				if (watch.stopped || state === "stopped" || state === "live") return;
				if (state === "backoff") lifecycle("disconnect", workspaceId, true, "socket_closed");
				if (state === "backoff" || state === "connecting") {
					watch.reconcileSeq += 1;
					watch.reconciling = false;
					watch.buffer = [];
				}
				setWatchState(watch, state, attempt);
			},
			onStop: (reason) => onSocketStop(watch, reason),
		});
		watch.socket.start();
	}

	function onSocketStop(watch: Watch, reason: WorkspaceSocketStop): void {
		if (watch.stopped) return;
		if (reason === "unauthorized") {
			signedOut();
			return;
		}
		haltWorkspace(watch, reason === "gone" ? "gone" : "no_access");
	}

	/** The workspace cannot be read any more: stop it and forget what was held for it. */
	function haltWorkspace(watch: Watch, state: "gone" | "no_access"): void {
		stopWatch(watch, state);
		clearWorkspace(model, watch.workspaceId);
		lifecycle("disconnect", watch.workspaceId, false, state);
		refreshStatus();
		changed();
	}

	function stopWatch(watch: Watch, state: MulticaWorkspaceWatchState): void {
		watch.stopped = true;
		watch.socket?.stop();
		watch.socket = null;
		for (const key of Object.keys(watch.timers) as Array<keyof Watch["timers"]>) {
			clearTimer(watch.timers[key]);
			watch.timers[key] = null;
		}
		watch.buffer = [];
		watch.state = state;
		watch.attempt = 0;
		if (state === "idle") {
			watches.delete(watch.workspaceId);
			clearWorkspace(model, watch.workspaceId);
		}
		changed();
	}

	// Frames

	function handleFrame(watch: Watch, raw: string): void {
		if (watch.stopped) return;
		const frame = parseFrame(raw);
		if (!frame) return;
		if (watch.reconciling) {
			if (watch.buffer.length < MAX_BUFFERED_FRAMES) watch.buffer.push(frame);
			else watch.rerun = true;
			return;
		}
		applyOne(watch, frame);
	}

	function applyOne(watch: Watch, frame: ParsedFrame): void {
		const result = applyFrame(model, frame, context(watch.workspaceId));
		for (const effect of result.effects) runEffect(watch, effect);
		if (result.changed) changed();
	}

	function runEffect(watch: Watch, effect: FrameEffect): void {
		switch (effect.type) {
			case "stop":
				haltWorkspace(watch, effect.reason);
				return;
			case "refetch_issue":
				fire(refetchIssue(watch, effect.issueId));
				return;
			case "refresh_agents":
				debounce(watch, "agents", () => fire(refreshAgents(watch)));
				return;
			case "refresh_snapshot":
				debounce(watch, "snapshot", () => fire(refreshSnapshot(watch)));
				return;
		}
	}

	function debounce(watch: Watch, key: "agents" | "snapshot", action: () => void): void {
		if (watch.timers[key] !== null) return;
		watch.timers[key] = scheduler.setTimeout(() => {
			watch.timers[key] = null;
			if (!watch.stopped) action();
		}, AGENT_REFRESH_DEBOUNCE_MS);
	}

	async function refetchIssue(watch: Watch, issueId: string): Promise<void> {
		if (!client) return;
		const myEpoch = epoch;
		const result = await client.getIssue({ id: watch.workspaceId }, issueId);
		if (stopped || watch.stopped || myEpoch !== epoch || !result.ok) return;
		const issue = projectIssue(result.data, watch.workspaceId);
		if (issue && storeIssue(issue)) changed();
	}

	async function refreshAgents(watch: Watch): Promise<void> {
		if (!client) return;
		const myEpoch = epoch;
		const result = await client.agents({ id: watch.workspaceId });
		if (stopped || watch.stopped || myEpoch !== epoch || !result.ok) return;
		const agents = listItems(result.data, "agents").map((raw) => projectAgent(raw, watch.workspaceId)).filter((agent) => agent !== null);
		if (replaceAgents(model, watch.workspaceId, agents)) changed();
	}

	async function refreshSnapshot(watch: Watch): Promise<void> {
		if (!client) return;
		const myEpoch = epoch;
		const result = await client.taskSnapshot({ id: watch.workspaceId });
		if (stopped || watch.stopped || myEpoch !== epoch || !result.ok) return;
		const runs = projectRuns(result, watch.workspaceId);
		const outcome = reconcileRuns(model, { workspaceId: watch.workspaceId, snapshotRuns: runs, nowIso: nowIso() });
		if (outcome.changed) changed();
	}

	function projectRuns(result: ReadResult, workspaceId: string): AwarenessRun[] {
		if (!result.ok) return [];
		return listItems(result.data, "tasks")
			.map((raw) => projectRun(raw, workspaceId, nowIso()))
			.filter((run) => run !== null);
	}

	/** Keeps the fresher revision; true when the model changed. */
	function storeIssue(issue: AwarenessIssue): boolean {
		const held = model.issues.get(issue.id);
		if (held && held.revision > issue.revision) return false;
		if (held && JSON.stringify(held) === JSON.stringify(issue)) return false;
		model.issues.set(issue.id, issue);
		model.deleted.delete(issue.id);
		return true;
	}

	// Reconcile

	async function runReconcile(watch: Watch): Promise<void> {
		if (stopped || watch.stopped || watch.reconciling || !client) return;
		const myEpoch = epoch;
		const seq = (watch.reconcileSeq += 1);
		watch.reconciling = true;
		watch.buffer = [];
		watch.rerun = false;
		clearTimer(watch.timers.safety);
		clearTimer(watch.timers.poll);
		const outcome = await reconcile(watch, myEpoch, seq);
		if (stopped || watch.stopped || myEpoch !== epoch || seq !== watch.reconcileSeq) return;
		if (outcome === "unauthorized") {
			if (pageMode) {
				watch.reconciling = false;
				setWatchState(watch, "connecting");
				schedulePoll(watch, PAGE_POLL_MS);
				return;
			}
			signedOut();
			return;
		}
		if (outcome === "gone" || outcome === "no_access") {
			haltWorkspace(watch, outcome);
			return;
		}
		// Apply what arrived while reading; the revision and rank guards make a repeat harmless.
		const buffered = watch.buffer;
		watch.buffer = [];
		watch.reconciling = false;
		if (outcome === "ok") {
			for (const frame of buffered) {
				if (watch.stopped) return;
				applyOne(watch, frame);
			}
			// A buffered frame may have stopped the workspace (deleted, membership removed): do not revive it.
			if (watch.stopped) return;
			if (watch.rerun) {
				watch.rerun = false;
				fire(runReconcile(watch));
				return;
			}
			setWatchState(watch, "live", 0);
			watch.timers.safety = scheduler.setTimeout(() => fire(runReconcile(watch)), SAFETY_RECONCILE_MS);
			if (pageMode) schedulePoll(watch, PAGE_POLL_MS);
		} else {
			// A failed read leaves the watch degraded; try again no more often than once a minute.
			// Not live: the socket may be up, but the workspace has not been read in full.
			setWatchState(watch, "connecting");
			watch.timers.safety = scheduler.setTimeout(() => fire(runReconcile(watch)), DEGRADED_RECONCILE_MS);
			refreshStatus();
		}
		changed();
	}

	function failureOutcome(result: ReadResult): ReconcileOutcome | null {
		if (result.ok) return null;
		if (result.kind === "unauthorized") return "unauthorized";
		if (result.kind === "forbidden") return "no_access";
		if (result.kind === "not_found") return "gone";
		return "failed";
	}

	async function reconcile(watch: Watch, myEpoch: number, seq: number): Promise<ReconcileOutcome> {
		const c = client;
		if (!c) return "failed";
		const ref = { id: watch.workspaceId };
		const alive = () => !stopped && !watch.stopped && myEpoch === epoch && seq === watch.reconcileSeq;

		const snapshot = await c.taskSnapshot(ref);
		if (!alive()) return "failed";
		const snapshotFailure = failureOutcome(snapshot);
		if (snapshotFailure) return snapshotFailure;
		const runs = projectRuns(snapshot, watch.workspaceId);
		const reconciled = reconcileRuns(model, { workspaceId: watch.workspaceId, snapshotRuns: runs, nowIso: nowIso() });

		const agents = await c.agents(ref);
		if (!alive()) return "failed";
		// Every read the reconcile needs must succeed: a half-read workspace is not live, it is degraded and retried.
		const agentsFailure = failureOutcome(agents);
		if (agentsFailure) return agentsFailure;
		replaceAgents(model, watch.workspaceId, listItems(agents.ok ? agents.data : null, "agents").map((raw) => projectAgent(raw, watch.workspaceId)).filter((agent) => agent !== null));
		const runtimes = await c.runtimes(ref);
		if (!alive()) return "failed";
		const runtimesFailure = failureOutcome(runtimes);
		if (runtimesFailure) return runtimesFailure;
		replaceRuntimes(model, watch.workspaceId, listItems(runtimes.ok ? runtimes.data : null, "runtimes").map((raw) => projectRuntime(raw, watch.workspaceId)).filter((runtime) => runtime !== null));

		// Issues of interest.
		const fetched = new Map<string, AwarenessIssue>();
		const take = (result: ReadResult, key: string): boolean => {
			if (!result.ok) return false;
			for (const raw of listItems(result.data, key)) {
				const issue = projectIssue(raw, watch.workspaceId);
				if (issue && issue.workspaceId === watch.workspaceId) fetched.set(issue.id, issue);
			}
			return true;
		};
		let partial = false;

		// (b) issues with an active run, by ids in batches of 100.
		const activeIssueIds = new Set<string>();
		for (const run of model.runs.values()) {
			if (run.workspaceId === watch.workspaceId && MULTICA_ACTIVE_TASK_STATUSES.includes(run.status) && !run.outcomeUnknown) activeIssueIds.add(run.issueId);
		}
		const ids = [...activeIssueIds];
		for (let index = 0; index < ids.length; index += RECONCILE_PAGE_SIZE) {
			const result = await c.listIssues(ref, { ids: ids.slice(index, index + RECONCILE_PAGE_SIZE), limit: RECONCILE_PAGE_SIZE });
			if (!alive()) return "failed";
			const failure = failureOutcome(result);
			if (failure) return failure;
			take(result, "issues");
		}

		// (a) issues an AO session is linked to; a 404 means the issue is gone.
		const linked = options.linkedIdentifiers(slugOf(watch.workspaceId)).slice(0, RECONCILE_LINKED_LIMIT);
		for (const identifier of linked) {
			const result = await c.getIssue(ref, identifier);
			if (!alive()) return "failed";
			if (result.ok) {
				const issue = projectIssue(result.data, watch.workspaceId);
				if (issue) fetched.set(issue.id, issue);
			} else if (result.kind !== "not_found") {
				// Not found means the issue is gone; any other failure leaves the reconcile incomplete.
				return failureOutcome(result) ?? "failed";
			} else {
				for (const held of model.issues.values()) {
					if (held.workspaceId === watch.workspaceId && held.identifier.toUpperCase() === identifier) {
						model.deleted.set(held.id, { workspaceId: held.workspaceId, identifier: held.identifier });
						model.issues.delete(held.id);
					}
				}
			}
		}

		// (c) my open issues, (d) open issues assigned to an agent or squad: newest first, at most 3 pages each.
		const queries: Array<Parameters<MulticaReadClient["listIssues"]>[1]> = [];
		if (meId) queries.push({ assigneeTypes: ["member"], assigneeIds: [meId], openOnly: true, sort: "updated_at", direction: "desc" });
		queries.push({ assigneeTypes: ["agent", "squad"], openOnly: true, sort: "updated_at", direction: "desc" });
		for (const query of queries) {
			for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
				const result = await c.listIssues(ref, { ...query, limit: RECONCILE_PAGE_SIZE, offset: page * RECONCILE_PAGE_SIZE });
				if (!alive()) return "failed";
				const failure = failureOutcome(result);
				if (failure) return failure;
				if (!take(result, "issues")) break;
				const count = listItems(result.ok ? result.data : null, "issues").length;
				if (count < RECONCILE_PAGE_SIZE) break;
				if (page === RECONCILE_MAX_PAGES - 1) partial = true;
			}
		}

		// Fetched truth replaces held issues unless the held one is newer.
		for (const issue of fetched.values()) storeIssue(issue);
		for (const held of [...model.issues.values()]) {
			if (held.workspaceId === watch.workspaceId && !isOfInterest(model, held, context(watch.workspaceId))) model.issues.delete(held.id);
		}

		// Runs that ended while AO was not looking: read the outcome once (at most 10).
		for (const unknown of reconciled.unknownOutcome.slice(0, RECONCILE_UNKNOWN_OUTCOME_LIMIT)) {
			const result = await c.taskRuns(ref, unknown.issueId);
			if (!alive()) return "failed";
			if (!result.ok) {
				if (result.kind === "unauthorized") return "unauthorized";
				continue;
			}
			const match = projectRuns(result, watch.workspaceId).find((run) => run.id === unknown.id);
			if (match) resolveUnknownOutcome(model, match);
		}

		enforceCaps(model, context(watch.workspaceId));
		watch.partial = partial;
		return "ok";
	}

	// Page-only polling

	function schedulePoll(watch: Watch, delayMs: number): void {
		clearTimer(watch.timers.poll);
		watch.timers.poll = scheduler.setTimeout(() => fire(pollPage(watch)), delayMs);
	}

	async function pollPage(watch: Watch): Promise<void> {
		if (stopped || watch.stopped) return;
		const host = options.pageHost();
		if (!host || host.activeServerKey() !== server.key) {
			setWatchState(watch, "idle");
			setStatus("paused");
			schedulePoll(watch, PAGE_POLL_MS);
			return;
		}
		// The page shows one workspace: only that one is read.
		const slug = await host.readActiveSlug();
		if (stopped || watch.stopped) return;
		if (slug === null || slug !== slugOf(watch.workspaceId).toLowerCase()) {
			setWatchState(watch, "idle");
			schedulePoll(watch, PAGE_POLL_MS);
			return;
		}
		if (status === "paused") setStatus("connecting");
		await runReconcile(watch);
	}

	// Public

	return {
		start: () => {
			if (started || stopped) return;
			started = true;
			fire(begin());
		},
		stop: () => {
			if (stopped) return;
			stopped = true;
			epoch += 1;
			for (const watch of [...watches.values()]) stopWatch(watch, "idle");
			client?.dispose();
			client = null;
			token = null;
			clearTimer(startTimer);
			clearTimer(meTimer);
			startTimer = null;
			meTimer = null;
			lifecycle("disconnect", undefined, true, "stopped");
		},
		setWatched: (workspaceIds) => {
			wantedWatched = [...workspaceIds];
			if (started && !stopped) applyWatched();
		},
		refreshWorkspaces: async () => {
			if (stopped || !client) return;
			await loadWorkspaces(epoch);
		},
		noteLinksChanged: () => {
			for (const watch of watches.values()) {
				if (!watch.stopped && !watch.reconciling && watch.state === "live") fire(runReconcile(watch));
			}
		},
		view: () => ({
			status,
			meId,
			model,
			workspaces: [...known.values()].map((workspace): AwarenessWorkspaceState => {
				const watch = watches.get(workspace.id);
				return {
					workspaceId: workspace.id,
					slug: workspace.slug,
					name: workspace.name,
					watch: wantedWatched.includes(workspace.id),
					state: watch?.state ?? "idle",
					attempt: watch?.attempt ?? 0,
					partial: watch?.partial ?? false,
					transport: watch?.transport ?? (pageMode ? "page" : "socket"),
				};
			}),
		}),
		lookupAll: (identifier) => {
			const wanted = identifier.toUpperCase();
			const matches: Array<{ issue: AwarenessIssue; workspaceSlug: string; activeRuns: AwarenessRun[] }> = [];
			for (const issue of model.issues.values()) {
				if (issue.identifier.toUpperCase() !== wanted) continue;
				const activeRuns = [...model.runs.values()].filter(
					(run) => run.issueId === issue.id && MULTICA_ACTIVE_TASK_STATUSES.includes(run.status) && !run.outcomeUnknown,
				);
				matches.push({ issue, workspaceSlug: slugOf(issue.workspaceId), activeRuns });
			}
			return matches;
		},
	};
}

