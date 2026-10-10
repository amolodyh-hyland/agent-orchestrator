import type { MulticaIssueLink } from "../shared/multica-issue-links";
import {
	DEFAULT_MULTICA_SYNC_SETTINGS,
	isMulticaSyncKilled,
	type MulticaSyncFacts,
	type MulticaSyncLinkRef,
	type MulticaSyncLinkView,
	type MulticaSyncReason,
	type MulticaSyncSettings,
	type MulticaSyncSettingsPatch,
	type MulticaSyncSnapshot,
} from "../shared/multica-status-sync";
import {
	aggregateTargets,
	decideStatusWrite,
	isOwnEcho,
	type AggregateTarget,
	type LastKnownStatus,
	type MulticaIssueObservation,
	type MulticaWritableStatus,
	type SyncSessionFacts,
} from "../shared/multica-status-writer";
import { MULTICA_ISSUE_API_ALLOW_LIST, type MulticaApiFailure, type MulticaIssueApi } from "./multica-issue-api";
import type { MulticaIssueStableIds, MulticaIssueTarget } from "./multica-issue-links";
import {
	emptyMulticaSyncStateFile,
	MAX_MULTICA_SYNC_ISSUES,
	MAX_MULTICA_SYNC_LINKS,
	type MulticaSyncStateFile,
	type MulticaSyncStateStore,
	type PersistedIssueState,
} from "./multica-sync-state";

/**
 * One line of the audit trail: a status write attempt, a pause, or a resume.
 * Carries only allow-listed scalar request fields and ids: never a token, a
 * title, a description or any other text from Multica. A later action log
 * plugs in through the `record` option; today the sink is a no-op.
 */
export type MulticaSyncRecord = {
	kind: "status_write" | "pause" | "resume";
	at: string;
	serverKey: string;
	workspaceId: string | null;
	issueId: string | null;
	issueIdentifier: string;
	sessionId: string | null;
	request: { method: string; pathTemplate: string; fields: Record<string, string | number | boolean> } | null;
	revBefore: number | null;
	revAfter: number | null;
	result: { ok: boolean; httpStatus?: number; code?: string; reason?: string };
};

export type MulticaStatusSyncOptions = {
	api: MulticaIssueApi;
	store: MulticaSyncStateStore;
	/** Persists the issue's UUIDs on its links; the engine calls it the first time it reads the issue. */
	recordIssueIds?: (target: MulticaIssueTarget, ids: MulticaIssueStableIds) => Promise<unknown>;
	/** Audit hook, called after every write attempt, pause and resume. */
	record?: (entry: MulticaSyncRecord) => void;
	env?: Record<string, string | undefined>;
	now?: () => number;
	/** Changes within this window collapse into one write of the latest state. Default 5 s. */
	debounceMs?: number;
	/** Backoff after an unreachable server: starts here and doubles up to `maxRetryMs`. Defaults 5 s and 5 min. */
	minRetryMs?: number;
	maxRetryMs?: number;
	/** How often an enabled issue is read again to notice changes made in Multica. Default 10 min. */
	reconcileMs?: number;
	maxWritesPerIssuePerHour?: number;
	maxWritesPerServerPerMinute?: number;
};

export type MulticaStatusSync = {
	/** Settles when the persisted state has been read. */
	ready: Promise<void>;
	setFacts: (facts: MulticaSyncFacts) => void;
	/** The links of the selected server, after every change to them. */
	setLinks: (serverKey: string, links: readonly MulticaIssueLink[]) => void;
	/** The selected server changed (`""` when none): cancel everything for the old one. */
	handleServerChange: (serverKey: string) => void;
	getSnapshot: () => MulticaSyncSnapshot;
	onChanged: (listener: (snapshot: MulticaSyncSnapshot) => void) => () => void;
	setSettings: (patch: MulticaSyncSettingsPatch) => Promise<MulticaSyncSnapshot>;
	setLink: (request: MulticaSyncLinkRef & { enabled: boolean }) => Promise<MulticaSyncSnapshot>;
	resume: (ref: MulticaSyncLinkRef) => Promise<MulticaSyncSnapshot>;
	reopen: (ref: MulticaSyncLinkRef) => Promise<MulticaSyncSnapshot>;
	syncNow: (ref: MulticaSyncLinkRef) => Promise<MulticaSyncSnapshot>;
	/** The Multica page reported a sign-in again: lift the sign-in pause of the selected server. */
	notifySignedIn: () => void;
	dispose: () => void;
};

type Runtime = {
	state: PersistedIssueState;
	timer: ReturnType<typeof setTimeout> | null;
	reconcileTimer: ReturnType<typeof setTimeout> | null;
	running: boolean;
	rerun: boolean;
	/** The target the last successful evaluation saw; unchanged means nothing to do. */
	evaluatedSig: string | null;
	attempt: number;
	error: MulticaSyncReason | null;
	refused: MulticaSyncReason | null;
	observedStatus: string | null;
	writeTimes: number[];
	forceGet: boolean;
	reopenOnce: boolean;
	/** Identifies the evaluation that currently owns `running`; a pass that was superseded must not clear it. */
	run: number;
	/** Bumped when the work in flight for this issue must not go on: the master switch or a link was turned off, or the link is gone. */
	epoch: number;
};

type Group = {
	issueKey: string;
	serverKey: string;
	workspaceSlug: string;
	issueIdentifier: string;
	links: MulticaIssueLink[];
	writers: MulticaIssueLink[];
};

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const linkKeyOf = (serverKey: string, sessionId: string, workspaceSlug: string, issueIdentifier: string): string =>
	`${serverKey}\u0000${sessionId}\u0000${workspaceSlug}\u0000${issueIdentifier}`;
const issueKeyOf = (serverKey: string, workspaceSlug: string, issueIdentifier: string): string =>
	`${serverKey}\u0000${workspaceSlug}\u0000${issueIdentifier}`;

function sameRef(link: MulticaSyncLinkRef, ref: MulticaSyncLinkRef): boolean {
	return link.sessionId === ref.sessionId && link.workspaceSlug === ref.workspaceSlug && link.issueIdentifier === ref.issueIdentifier;
}

export function createMulticaStatusSync(options: MulticaStatusSyncOptions): MulticaStatusSync {
	const now = options.now ?? Date.now;
	const debounceMs = options.debounceMs ?? 5000;
	const minRetryMs = options.minRetryMs ?? 5000;
	const maxRetryMs = options.maxRetryMs ?? 5 * 60 * 1000;
	const reconcileMs = options.reconcileMs ?? 10 * 60 * 1000;
	const maxWritesPerIssuePerHour = options.maxWritesPerIssuePerHour ?? 12;
	const maxWritesPerServerPerMinute = options.maxWritesPerServerPerMinute ?? 30;
	const killed = isMulticaSyncKilled(options.env ?? process.env);

	let settings: MulticaSyncSettings = { ...DEFAULT_MULTICA_SYNC_SETTINGS };
	let serverKey = "";
	let links: MulticaIssueLink[] = [];
	let facts: MulticaSyncFacts | null = null;
	let factsBySession = new Map<string, SyncSessionFacts>();
	let loaded = false;
	// True once the links of the selected server have been reported; until then an empty list means "not known yet".
	let linksKnown = false;
	let disposed = false;
	let generation = 0;
	let lastEmitted = "";
	const enabledLinks = new Map<string, { serverKey: string } & MulticaSyncLinkRef>();
	const runtimes = new Map<string, Runtime>();
	const signedOutServers = new Set<string>();
	const serverWrites = new Map<string, number[]>();
	const listeners = new Set<(snapshot: MulticaSyncSnapshot) => void>();

	const active = (): boolean => !killed && settings.enabled;

	// --- persistence ---------------------------------------------------------

	const saveNow = (): Promise<void> => {
		const file: MulticaSyncStateFile = {
			settings,
			links: [...enabledLinks.values()].slice(-MAX_MULTICA_SYNC_LINKS),
			issues: [...runtimes.values()].map((runtime) => runtime.state).slice(-MAX_MULTICA_SYNC_ISSUES),
		};
		return options.store.save(file).catch(() => undefined);
	};
	const persist = (): void => {
		void saveNow();
	};

	// --- audit ---------------------------------------------------------------

	const audit = (entry: Omit<MulticaSyncRecord, "at">): void => {
		try {
			options.record?.({ ...entry, at: new Date(now()).toISOString() });
		} catch {
			// A failing audit sink must never stop sync.
		}
	};

	// --- groups --------------------------------------------------------------

	const buildGroups = (): Map<string, Group> => {
		// A session linked to several issues writes only to the first one it was linked to (Q14).
		const primary = new Set<string>();
		const firstBySession = new Map<string, MulticaIssueLink>();
		for (const link of links) {
			const current = firstBySession.get(link.sessionId);
			if (!current || link.createdAt < current.createdAt) firstBySession.set(link.sessionId, link);
		}
		for (const link of firstBySession.values()) primary.add(linkKeyOf(serverKey, link.sessionId, link.workspaceSlug, link.issueIdentifier));

		const groups = new Map<string, Group>();
		for (const link of links) {
			const issueKey = issueKeyOf(serverKey, link.workspaceSlug, link.issueIdentifier);
			let group = groups.get(issueKey);
			if (!group) {
				group = { issueKey, serverKey, workspaceSlug: link.workspaceSlug, issueIdentifier: link.issueIdentifier, links: [], writers: [] };
				groups.set(issueKey, group);
			}
			group.links.push(link);
			const key = linkKeyOf(serverKey, link.sessionId, link.workspaceSlug, link.issueIdentifier);
			if (enabledLinks.has(key) && primary.has(key)) group.writers.push(link);
		}
		return groups;
	};

	const makeRuntime = (state: PersistedIssueState): Runtime => ({
		state,
		timer: null,
		reconcileTimer: null,
		running: false,
		rerun: false,
		evaluatedSig: null,
		attempt: 0,
		error: null,
		refused: null,
		observedStatus: null,
		writeTimes: [],
		forceGet: false,
		reopenOnce: false,
		epoch: 0,
		run: 0,
	});

	const runtimeFor = (group: Pick<Group, "issueKey" | "serverKey" | "workspaceSlug" | "issueIdentifier">): Runtime => {
		let runtime = runtimes.get(group.issueKey);
		if (!runtime) {
			runtime = makeRuntime({
				serverKey: group.serverKey,
				workspaceSlug: group.workspaceSlug,
				issueIdentifier: group.issueIdentifier,
				lastKnown: null,
				pause: null,
				lastSyncAt: null,
				orphaned: false,
			});
			runtimes.set(group.issueKey, runtime);
		}
		return runtime;
	};

	const clearTimers = (runtime: Runtime): void => {
		if (runtime.timer !== null) clearTimeout(runtime.timer);
		if (runtime.reconcileTimer !== null) clearTimeout(runtime.reconcileTimer);
		runtime.timer = null;
		runtime.reconcileTimer = null;
	};

	const targetFor = (group: Group): AggregateTarget => {
		const sessions: SyncSessionFacts[] = [];
		for (const link of group.writers) {
			const entry = factsBySession.get(link.sessionId);
			if (entry) sessions.push(entry);
		}
		return aggregateTargets(sessions);
	};

	const signatureOf = (target: AggregateTarget): string => `${target.target ?? "-"}|${settings.moveOutOfBacklog ? "b" : "k"}`;

	// --- views ---------------------------------------------------------------

	const viewFor = (link: MulticaIssueLink, groups: Map<string, Group>): MulticaSyncLinkView => {
		const ref: MulticaSyncLinkRef = { sessionId: link.sessionId, workspaceSlug: link.workspaceSlug, issueIdentifier: link.issueIdentifier };
		const key = linkKeyOf(serverKey, link.sessionId, link.workspaceSlug, link.issueIdentifier);
		const enabled = enabledLinks.has(key);
		const base = { ...ref, enabled, multicaStatus: null, aoStatus: null, lastSyncAt: null, canResume: false, canReopen: false };
		if (!enabled) return { ...base, state: "off", reason: null };
		if (killed) return { ...base, state: "off", reason: "kill_switch" };
		if (!settings.enabled) return { ...base, state: "off", reason: "master_off" };

		const group = groups.get(issueKeyOf(serverKey, link.workspaceSlug, link.issueIdentifier));
		const runtime = runtimes.get(issueKeyOf(serverKey, link.workspaceSlug, link.issueIdentifier));
		const target = group ? targetFor(group).target : null;
		const detail = {
			...base,
			multicaStatus: runtime?.observedStatus ?? runtime?.state.lastKnown?.status ?? null,
			aoStatus: target,
			lastSyncAt: runtime?.state.lastSyncAt ?? null,
		};
		if (group && !group.writers.some((writer) => sameRef(writer, ref))) return { ...detail, state: "refused", reason: "secondary_link" };
		if (signedOutServers.has(serverKey)) return { ...detail, state: "error", reason: "signed_out" };
		if (facts?.stale) return { ...detail, state: "error", reason: "ao_offline" };
		if (runtime?.state.orphaned) return { ...detail, state: "error", reason: "orphaned" };
		if (runtime?.state.pause) {
			const reason = runtime.state.pause.reason;
			return { ...detail, state: "paused", reason, canResume: reason === "changed_in_multica", canReopen: reason !== "changed_in_multica" };
		}
		if (runtime?.error) return { ...detail, state: "error", reason: runtime.error };
		if (runtime?.refused) return { ...detail, state: "refused", reason: runtime.refused };
		if (facts === null || runtime === undefined || runtime.running || runtime.timer !== null || runtime.evaluatedSig === null) {
			return { ...detail, state: "pending", reason: null };
		}
		return { ...detail, state: "synced", reason: null };
	};

	const snapshot = (): MulticaSyncSnapshot => {
		const groups = buildGroups();
		return { settings: { ...settings }, killSwitch: killed, links: links.map((link) => viewFor(link, groups)) };
	};

	const emit = (): void => {
		if (disposed) return;
		const current = snapshot();
		const serialized = JSON.stringify(current);
		if (serialized === lastEmitted) return;
		lastEmitted = serialized;
		for (const listener of listeners) {
			try {
				listener(current);
			} catch {
				// A failing listener must not stop the others.
			}
		}
	};

	// --- scheduling ----------------------------------------------------------

	const schedule = (group: Group, delayMs: number): void => {
		const runtime = runtimeFor(group);
		if (runtime.timer !== null) return;
		runtime.timer = setTimeout(() => {
			runtime.timer = null;
			void evaluate(group.issueKey);
		}, delayMs);
	};

	const scheduleReconcile = (runtime: Runtime): void => {
		if (runtime.reconcileTimer !== null) clearTimeout(runtime.reconcileTimer);
		runtime.reconcileTimer = setTimeout(() => {
			runtime.reconcileTimer = null;
			runtime.evaluatedSig = null;
			runtime.forceGet = true;
			recompute();
		}, reconcileMs);
	};

	const recompute = (): void => {
		if (disposed || !loaded) return;
		const groups = buildGroups();
		for (const [issueKey, runtime] of runtimes) {
			const group = groups.get(issueKey);
			if (runtime.state.serverKey !== serverKey) continue;
			if (!group || group.writers.length === 0) clearTimers(runtime);
		}
		if (active() && facts !== null && !facts.stale && !signedOutServers.has(serverKey)) {
			for (const group of groups.values()) {
				if (group.writers.length === 0) continue;
				const runtime = runtimeFor(group);
				// A running evaluation looks again when it ends.
				if (runtime.running) continue;
				if (runtime.state.orphaned && !runtime.forceGet) continue;
				// No access stays until the user asks again (Sync now), not a retry loop.
				if (runtime.error === "no_access" && !runtime.forceGet) continue;
				if (runtime.evaluatedSig === signatureOf(targetFor(group)) && !runtime.forceGet) continue;
				schedule(group, debounceMs);
			}
		}
		emit();
	};

	// --- budgets -------------------------------------------------------------

	const prune = (times: number[], windowMs: number, at: number): void => {
		while (times.length > 0 && times[0] <= at - windowMs) times.shift();
	};

	/** Milliseconds until another write is allowed, or 0. */
	const budgetWait = (runtime: Runtime, key: string): number => {
		const at = now();
		const serverTimes = serverWrites.get(key) ?? [];
		prune(runtime.writeTimes, HOUR_MS, at);
		prune(serverTimes, MINUTE_MS, at);
		let wait = 0;
		if (runtime.writeTimes.length >= maxWritesPerIssuePerHour) wait = Math.max(wait, runtime.writeTimes[0] + HOUR_MS - at);
		if (serverTimes.length >= maxWritesPerServerPerMinute) wait = Math.max(wait, serverTimes[0] + MINUTE_MS - at);
		return wait;
	};

	const countWrite = (runtime: Runtime, key: string): void => {
		const at = now();
		runtime.writeTimes.push(at);
		const times = serverWrites.get(key) ?? [];
		times.push(at);
		serverWrites.set(key, times);
	};

	// --- evaluation ----------------------------------------------------------

	const retryDelay = (runtime: Runtime): number => Math.min(maxRetryMs, minRetryMs * 2 ** Math.min(runtime.attempt, 16));

	const failWith = (group: Group, runtime: Runtime, failure: MulticaApiFailure): void => {
		switch (failure.kind) {
			case "signed_out":
				// One 401 stops every link of this server: no retry storm until the user signs in again.
				signedOutServers.add(group.serverKey);
				runtime.error = "signed_out";
				return;
			case "not_found":
				runtime.state.orphaned = true;
				runtime.error = "orphaned";
				return;
			case "forbidden":
				runtime.error = "no_access";
				return;
			case "rate_limited":
				runtime.error = "rate_limited";
				runtime.attempt += 1;
				schedule(group, failure.retryAfterMs ?? retryDelay(runtime));
				return;
			case "unavailable":
				runtime.error = "unavailable";
				runtime.attempt += 1;
				schedule(group, retryDelay(runtime));
				return;
			default:
				runtime.error = "unreachable";
				runtime.attempt += 1;
				schedule(group, retryDelay(runtime));
		}
	};

	const requestFields = (status: MulticaWritableStatus, expectedRevision: number): Record<string, string | number | boolean> => ({
		status,
		expected_revision: expectedRevision,
		suppress_run: true,
	});

	const evaluate = async (issueKey: string): Promise<void> => {
		if (disposed || !loaded) return;
		const group = buildGroups().get(issueKey);
		if (!group || group.writers.length === 0 || !active()) return;
		const runtime = runtimeFor(group);
		if (runtime.running) {
			runtime.rerun = true;
			return;
		}
		runtime.running = true;
		const run = (runtime.run += 1);
		emit();
		const startedGeneration = generation;
		try {
			await evaluateOnce(group, runtime, startedGeneration);
		} catch {
			runtime.error = "unreachable";
			runtime.attempt += 1;
			schedule(group, retryDelay(runtime));
		} finally {
			// A server switch while this pass was awaiting hands `running` to a newer pass: leave it alone.
			if (runtime.run === run) {
				runtime.running = false;
				runtime.rerun = false;
			}
			persist();
			recompute();
			emit();
		}
	};

	const evaluateOnce = async (group: Group, runtime: Runtime, startedGeneration: number): Promise<void> => {
		const aggregate = targetFor(group);
		const target = aggregate.target;
		const signature = signatureOf(aggregate);
		const forceGet = runtime.forceGet;
		runtime.forceGet = false;
		// A confirmed reopen applies to this pass only.
		const reopenConfirmed = runtime.reopenOnce;
		runtime.reopenOnce = false;
		if (facts === null || facts.stale) return;
		if (signedOutServers.has(group.serverKey)) {
			runtime.error = "signed_out";
			return;
		}
		if (runtime.state.orphaned && !forceGet) {
			runtime.error = "orphaned";
			return;
		}

		// A paused issue writes nothing until AO's own mapped status changes to a new one, or the user resumes.
		const pause = runtime.state.pause;
		const stayPaused = pause !== null && (target === null || target === pause.target);
		if (stayPaused && !forceGet) {
			runtime.evaluatedSig = signature;
			return;
		}
		if (target === null && !forceGet) {
			runtime.error = null;
			runtime.evaluatedSig = signature;
			return;
		}

		const wait = budgetWait(runtime, group.serverKey);
		if (target !== null && wait > 0) {
			runtime.error = "rate_limited";
			schedule(group, wait);
			return;
		}

		const writerSession = aggregate.sessionId ?? group.writers[0]?.sessionId ?? null;
		const lookup = { workspaceSlug: group.workspaceSlug, identifier: group.issueIdentifier };

		// Turning sync or this link off, or removing the link, while a request is in flight must stop the
		// evaluation before it writes: checked after every await and right before the write.
		const epoch = runtime.epoch;
		const writerSessions = group.writers.map((link) => link.sessionId);
		const stillValid = (): boolean => {
			if (disposed || startedGeneration !== generation || runtime.epoch !== epoch || !active()) return false;
			const current = buildGroups().get(group.issueKey);
			if (!current) return false;
			const present = new Set(current.writers.map((link) => link.sessionId));
			return writerSessions.every((sessionId) => present.has(sessionId));
		};

		// Read, decide, write with expected_revision. A stale revision means someone changed the
		// issue in between: read once more and decide again, then give up until the next pass.
		for (let pass = 0; pass < 2; pass += 1) {
			const read = await options.api.getIssue(group.serverKey, lookup);
			if (!stillValid()) return;
			if (!read.ok) {
				failWith(group, runtime, read);
				return;
			}
			const issue = read.issue;
			runtime.error = null;
			runtime.observedStatus = issue.status;
			const identityOk = await confirmIdentity(group, runtime, issue);
			if (!stillValid()) return;
			if (!identityOk) {
				runtime.evaluatedSig = signature;
				scheduleReconcile(runtime);
				return;
			}

			// A write whose answer was lost (timeout, app quit) shows up here as the intended status at a newer revision.
			const intent = runtime.state.intent;
			if (intent) {
				if (issue.category === intent.category && issue.revision > intent.revBefore) {
					runtime.state.lastKnown = {
						status: issue.status,
						category: issue.category,
						revision: issue.revision,
						source: "write",
						at: new Date(now()).toISOString(),
					};
				}
				runtime.state.intent = null;
			}

			const decision = decideStatusWrite({
				target,
				current: issue,
				lastKnown: runtime.state.lastKnown,
				moveOutOfBacklog: settings.moveOutOfBacklog,
				reopenConfirmed,
			});
			const stamp = new Date(now()).toISOString();

			if (decision.action === "refuse") {
				runtime.refused = decision.reason;
				runtime.evaluatedSig = signature;
				runtime.state.lastSyncAt = stamp;
				scheduleReconcile(runtime);
				return;
			}
			runtime.refused = null;

			if (decision.action === "pause") {
				const unchanged = pause !== null && pause.reason === decision.reason && pause.target === target;
				if (!unchanged) {
					runtime.state.pause = { reason: decision.reason, target, observedStatus: issue.status, at: stamp };
					// The person's status is the new baseline; AO looks again only when its own status changes.
					runtime.state.lastKnown = observedKnown(issue);
					audit({
						kind: "pause",
						serverKey: group.serverKey,
						workspaceId: issue.workspaceId,
						issueId: issue.id,
						issueIdentifier: group.issueIdentifier,
						sessionId: writerSession,
						request: null,
						revBefore: issue.revision,
						revAfter: null,
						result: { ok: true, reason: decision.reason },
					});
				}
				runtime.evaluatedSig = signature;
				runtime.state.lastSyncAt = stamp;
				return;
			}

			if (decision.action === "none" || stayPaused) {
				if (decision.action === "none" && decision.reason === "agrees") {
					// Multica already shows what AO wants (possibly AO's own write coming back): agreement ends a pause.
					runtime.state.pause = null;
					if (!isOwnEcho(issue, runtime.state.lastKnown)) runtime.state.lastKnown = observedKnown(issue);
				}
				runtime.evaluatedSig = signature;
				runtime.attempt = 0;
				runtime.state.lastSyncAt = stamp;
				scheduleReconcile(runtime);
				return;
			}

			// A sub-issue: Multica runs its parent's sub-issue rules after any status change, and `suppress_run`
			// does not cover them, so finishing a sub-issue can wake the parent's agent or squad leader.
			// AO does not write unless it has read the parent and a member (or nobody) owns it.
			if (issue.parentIssueId) {
				const parent = await options.api.getParent(group.serverKey, { workspaceSlug: group.workspaceSlug, issueId: issue.parentIssueId });
				if (!stillValid()) return;
				if (!parent.ok && (parent.kind === "signed_out" || parent.kind === "rate_limited" || parent.kind === "unavailable" || parent.kind === "timeout" || parent.kind === "server_error")) {
					failWith(group, runtime, parent);
					return;
				}
				if (!parent.ok || parent.issue.assigneeType === "agent" || parent.issue.assigneeType === "squad") {
					runtime.refused = "sub_issue_parent";
					runtime.evaluatedSig = signature;
					scheduleReconcile(runtime);
					return;
				}
			}

			// A write. Moving out of Backlog first asks Multica whether it would start a run.
			if (decision.fromBacklog) {
				const preview = await options.api.previewTrigger(group.serverKey, {
					workspaceSlug: group.workspaceSlug,
					issueId: issue.id,
					status: decision.status,
				});
				if (!stillValid()) return;
				if (!preview.ok) {
					failWith(group, runtime, preview);
					return;
				}
				if (preview.triggers > 0) {
					runtime.refused = "would_start_run";
					runtime.evaluatedSig = signature;
					scheduleReconcile(runtime);
					return;
				}
			}

			const writeStatus = decision.status;
			const revBefore = issue.revision;
			const recordWrite = (result: MulticaSyncRecord["result"], revAfter: number | null): void =>
				audit({
					kind: "status_write",
					serverKey: group.serverKey,
					workspaceId: issue.workspaceId,
					issueId: issue.id,
					issueIdentifier: group.issueIdentifier,
					sessionId: writerSession,
					request: {
						method: MULTICA_ISSUE_API_ALLOW_LIST.put_status.method,
						pathTemplate: MULTICA_ISSUE_API_ALLOW_LIST.put_status.pathTemplate,
						fields: requestFields(writeStatus, revBefore),
					},
					revBefore,
					revAfter,
					result,
				});

			// Reserved before the request goes out, so issues evaluating at the same moment share the budget.
			const budget = budgetWait(runtime, group.serverKey);
			if (budget > 0) {
				runtime.error = "rate_limited";
				schedule(group, budget);
				return;
			}
			if (!stillValid()) return;
			countWrite(runtime, group.serverKey);
			runtime.state.intent = { status: writeStatus, category: writeStatus, revBefore, at: stamp };
			await saveNow();
			if (!stillValid()) {
				// Nothing was sent: no intent to remember, and the budget slot is given back.
				runtime.state.intent = null;
				runtime.writeTimes.pop();
				const times = serverWrites.get(group.serverKey);
				times?.pop();
				return;
			}
			const put = await options.api.putStatus(group.serverKey, {
				workspaceSlug: group.workspaceSlug,
				issueId: issue.id,
				status: writeStatus,
				expectedRevision: revBefore,
			});

			// A definite answer settles the intent; a lost or unclear one keeps it for the next read.
			if (put.ok || !["timeout", "unavailable", "unreadable", "server_error"].includes(put.kind)) runtime.state.intent = null;
			if (put.ok) {
				// Applied even if the server was switched meanwhile: the state belongs to its own server.
				runtime.state.lastKnown = {
					status: put.issue.status,
					category: put.issue.category,
					revision: put.issue.revision,
					source: "write",
					at: stamp,
				};
				runtime.state.pause = null;
				runtime.observedStatus = put.issue.status;
				runtime.attempt = 0;
				runtime.error = null;
				runtime.evaluatedSig = signature;
				runtime.state.lastSyncAt = stamp;
				recordWrite({ ok: true, httpStatus: 200 }, put.issue.revision);
				scheduleReconcile(runtime);
				return;
			}

			recordWrite(
				{
					ok: false,
					...(put.httpStatus !== undefined ? { httpStatus: put.httpStatus } : {}),
					...(put.code !== undefined ? { code: put.code } : {}),
					reason: put.kind,
				},
				null,
			);
			if (startedGeneration !== generation) return;
			if (put.kind === "conflict") {
				if (pass === 0) continue;
				// Still changing: leave it to the next scheduled pass.
				runtime.attempt += 1;
				schedule(group, debounceMs);
				return;
			}
			if (put.kind === "in_triage") {
				// The write itself says the issue is in Triage: Multica drives it (the PUT guard only locks the parent field today).
				runtime.refused = "triage";
				runtime.evaluatedSig = signature;
				scheduleReconcile(runtime);
				return;
			}
			failWith(group, runtime, put);
			return;
		}
	};

	const observedKnown = (issue: MulticaIssueObservation): LastKnownStatus => ({
		status: issue.status,
		category: issue.category,
		revision: issue.revision,
		source: "observed",
		at: new Date(now()).toISOString(),
	});

	/** Checks the issue is the one the link was made to; records its ids the first time. False stops the evaluation. */
	const confirmIdentity = async (group: Group, runtime: Runtime, issue: MulticaIssueObservation): Promise<boolean> => {
		const known = group.links.find((link) => link.workspaceId !== undefined && link.issueId !== undefined);
		if (known) {
			if (known.workspaceId !== issue.workspaceId || known.issueId !== issue.id) {
				// The identifier now names another issue (renumbered, moved, prefix changed): never write to it.
				runtime.refused = "identity_changed";
				return false;
			}
			return true;
		}
		try {
			await options.recordIssueIds?.(
				{ serverKey: group.serverKey, workspaceSlug: group.workspaceSlug, issueIdentifier: group.issueIdentifier },
				{ workspaceId: issue.workspaceId, issueId: issue.id },
			);
		} catch {
			// Recording the ids is best effort; the next read tries again.
		}
		return true;
	};

	// --- public API ----------------------------------------------------------

	const ready = options.store
		.load()
		.catch(() => emptyMulticaSyncStateFile())
		.then((file) => {
			if (disposed) return;
			settings = file.settings;
			for (const link of file.links) enabledLinks.set(linkKeyOf(link.serverKey, link.sessionId, link.workspaceSlug, link.issueIdentifier), link);
			for (const issue of file.issues) {
				const issueKey = issueKeyOf(issue.serverKey, issue.workspaceSlug, issue.issueIdentifier);
				runtimes.set(issueKey, makeRuntime(issue));
			}
			loaded = true;
			applyLinkPruning();
			recompute();
		});

	function applyLinkPruning(): void {
		// Never prune from a list that was only emptied by a server switch: the links of the new server are not here yet.
		if (!loaded || serverKey === "" || !linksKnown) return;
		let changed = false;
		const current = new Set(links.map((link) => linkKeyOf(serverKey, link.sessionId, link.workspaceSlug, link.issueIdentifier)));
		for (const [key, entry] of enabledLinks) {
			if (entry.serverKey === serverKey && !current.has(key)) {
				enabledLinks.delete(key);
				changed = true;
			}
		}
		const issues = new Set(links.map((link) => issueKeyOf(serverKey, link.workspaceSlug, link.issueIdentifier)));
		for (const [issueKey, runtime] of runtimes) {
			const stillEnabled = [...enabledLinks.values()].some(
				(entry) => issueKeyOf(entry.serverKey, entry.workspaceSlug, entry.issueIdentifier) === issueKey,
			);
			if (runtime.state.serverKey === serverKey && (!issues.has(issueKey) || !stillEnabled)) {
				clearTimers(runtime);
				runtime.epoch += 1;
				runtimes.delete(issueKey);
				changed = true;
			}
		}
		if (changed) persist();
	}

	/** Switches to another server: everything in flight or queued for the old one is dropped. */
	function adoptServer(key: string): void {
		generation += 1;
		serverKey = key;
		links = [];
		linksKnown = false;
		for (const runtime of runtimes.values()) {
			clearTimers(runtime);
			runtime.running = false;
			runtime.run += 1;
			runtime.rerun = false;
			runtime.evaluatedSig = null;
			runtime.error = null;
			runtime.refused = null;
		}
		emit();
	}

	const findLink = (ref: MulticaSyncLinkRef): MulticaIssueLink | undefined => links.find((link) => sameRef(link, ref));

	const nowOrNothing = async (): Promise<MulticaSyncSnapshot> => {
		emit();
		return snapshot();
	};

	const wake = (group: Group, runtime: Runtime): void => {
		runtime.evaluatedSig = null;
		runtime.error = null;
		runtime.attempt = 0;
		if (runtime.timer !== null) clearTimeout(runtime.timer);
		runtime.timer = null;
		runtime.timer = setTimeout(() => {
			runtime.timer = null;
			void evaluate(group.issueKey);
		}, 0);
	};

	const actOnLink = async (
		ref: MulticaSyncLinkRef,
		action: (group: Group, runtime: Runtime, link: MulticaIssueLink) => void,
	): Promise<MulticaSyncSnapshot> => {
		await ready;
		const link = findLink(ref);
		if (disposed || !link) return snapshot();
		const group = buildGroups().get(issueKeyOf(serverKey, link.workspaceSlug, link.issueIdentifier));
		if (!group) return snapshot();
		action(group, runtimeFor(group), link);
		persist();
		return nowOrNothing();
	};

	return {
		ready,
		setFacts: (next) => {
			facts = next;
			factsBySession = new Map(next.sessions.map((session) => [session.sessionId, session]));
			recompute();
		},
		setLinks: (key, next) => {
			// The link service learns the selected server before the view host announces it.
			if (key !== serverKey) adoptServer(key);
			links = next.filter((link) => link.serverKey === key);
			linksKnown = true;
			applyLinkPruning();
			recompute();
		},
		handleServerChange: (key) => {
			if (key !== serverKey) adoptServer(key);
		},
		getSnapshot: snapshot,
		onChanged: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		setSettings: async (patch) => {
			await ready;
			if (disposed) return snapshot();
			settings = { ...settings, ...patch };
			for (const runtime of runtimes.values()) runtime.evaluatedSig = null;
			if (!active()) {
				for (const runtime of runtimes.values()) {
					clearTimers(runtime);
					runtime.epoch += 1;
				}
			}
			persist();
			recompute();
			return snapshot();
		},
		setLink: async (request) => {
			await ready;
			const link = findLink(request);
			if (disposed || !link) return snapshot();
			const key = linkKeyOf(serverKey, link.sessionId, link.workspaceSlug, link.issueIdentifier);
			if (request.enabled) {
				enabledLinks.set(key, { serverKey, sessionId: link.sessionId, workspaceSlug: link.workspaceSlug, issueIdentifier: link.issueIdentifier });
				const issueKey = issueKeyOf(serverKey, link.workspaceSlug, link.issueIdentifier);
				const runtime = runtimes.get(issueKey);
				if (runtime) {
					runtime.evaluatedSig = null;
					runtime.error = null;
					runtime.refused = null;
				}
				signedOutServers.delete(serverKey);
			} else {
				enabledLinks.delete(key);
				const turnedOff = runtimes.get(issueKeyOf(serverKey, link.workspaceSlug, link.issueIdentifier));
				if (turnedOff) turnedOff.epoch += 1;
				applyLinkPruning();
			}
			persist();
			recompute();
			return snapshot();
		},
		resume: (ref) =>
			actOnLink(ref, (group, runtime) => {
				const pause = runtime.state.pause;
				// A closed or blocked issue needs the explicit, confirmed reopen instead.
				if (!active() || !pause || pause.reason !== "changed_in_multica") return;
				runtime.state.pause = null;
				// AO takes over again: the person's status is no longer a baseline to defend.
				runtime.state.lastKnown = null;
				audit({
					kind: "resume",
					serverKey: group.serverKey,
					workspaceId: group.links.find((link) => link.workspaceId)?.workspaceId ?? null,
					issueId: group.links.find((link) => link.issueId)?.issueId ?? null,
					issueIdentifier: group.issueIdentifier,
					sessionId: ref.sessionId,
					request: null,
					revBefore: null,
					revAfter: null,
					result: { ok: true, reason: "resumed_by_user" },
				});
				wake(group, runtime);
			}),
		reopen: (ref) =>
			actOnLink(ref, (group, runtime) => {
				const pause = runtime.state.pause;
				// A confirmation given while sync is off must not wait around for the day it is turned on.
				if (!active() || !pause || pause.reason === "changed_in_multica") return;
				runtime.state.pause = null;
				runtime.reopenOnce = true;
				audit({
					kind: "resume",
					serverKey: group.serverKey,
					workspaceId: group.links.find((link) => link.workspaceId)?.workspaceId ?? null,
					issueId: group.links.find((link) => link.issueId)?.issueId ?? null,
					issueIdentifier: group.issueIdentifier,
					sessionId: ref.sessionId,
					request: null,
					revBefore: null,
					revAfter: null,
					result: { ok: true, reason: "reopen_confirmed_by_user" },
				});
				wake(group, runtime);
			}),
		syncNow: (ref) =>
			actOnLink(ref, (group, runtime) => {
				if (!active() || group.writers.length === 0) return;
				signedOutServers.delete(group.serverKey);
				runtime.state.orphaned = false;
				runtime.forceGet = true;
				wake(group, runtime);
			}),
		notifySignedIn: () => {
			if (signedOutServers.delete(serverKey)) {
				for (const runtime of runtimes.values()) {
					if (runtime.state.serverKey !== serverKey) continue;
					runtime.evaluatedSig = null;
					if (runtime.error === "signed_out") runtime.error = null;
				}
				recompute();
			}
		},
		dispose: () => {
			disposed = true;
			for (const runtime of runtimes.values()) clearTimers(runtime);
			listeners.clear();
		},
	};
}
