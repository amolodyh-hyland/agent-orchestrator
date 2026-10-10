import { EMPTY_AWARENESS_STATE, type AwarenessRun, type AwarenessState } from "../../shared/multica-awareness";

export const NOW_ISO = new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const awarenessRun = (overrides: Partial<AwarenessRun> = {}): AwarenessRun & { serverKey: string } => ({
	serverKey: "cloud",
	id: "t1",
	workspaceId: "w1",
	issueId: "i1",
	agentId: "a1",
	status: "running",
	failureReason: null,
	retryPending: false,
	outcomeUnknown: false,
	startedAt: minutesAgo(3),
	endedAt: null,
	isLeaderTask: false,
	autopilotRunId: null,
	parentTaskId: null,
	runtimeId: null,
	...overrides,
});

export function awarenessState(overrides: Partial<AwarenessState> = {}): AwarenessState {
	return {
		...EMPTY_AWARENESS_STATE,
		masterEnabled: true,
		tokenStoragePersistent: true,
		servers: [
			{
				serverKey: "cloud",
				label: "Multica Cloud",
				mode: "cloud",
				customUrl: "",
				apiUrl: "",
				enabled: true,
				credentialSource: "pasted",
				consentGranted: false,
				hasPastedToken: true,
				status: "live",
				meId: "me",
				workspaces: [{ workspaceId: "w1", slug: "acme", name: "Acme", watch: true, state: "live", attempt: 0, partial: false, transport: "socket" }],
			},
		],
		issues: [
			{ serverKey: "cloud", id: "i1", workspaceId: "w1", identifier: "MUL-1", title: "Fix the board", status: "todo", statusCategory: "todo", assigneeType: "agent", assigneeId: "a1", parentIssueId: null, projectId: null, revision: 1, updatedAt: minutesAgo(30) },
			{ serverKey: "cloud", id: "i2", workspaceId: "w1", identifier: "MUL-2", title: "My own issue", status: "todo", statusCategory: "todo", assigneeType: "member", assigneeId: "me", parentIssueId: null, projectId: null, revision: 1, updatedAt: minutesAgo(20) },
		],
		runs: [awarenessRun()],
		agents: [{ serverKey: "cloud", id: "a1", workspaceId: "w1", name: "Builder", runtimeId: null }],
		...overrides,
	};
}
