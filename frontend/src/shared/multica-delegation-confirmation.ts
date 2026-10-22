export const DELEGATION_STATUS = "multicaDelegation:status";
export const DELEGATION_CANCEL_CLICK = "multicaDelegation:cancelClick";
export const DELEGATION_PREVIEW = "multicaDelegation:preview";
export const DELEGATION_CANCEL_PREVIEW = "multicaDelegation:cancelPreview";
export const DELEGATION_CONFIRM_CLICK = "multicaDelegation:confirmClick";
export const DELEGATION_RESULT = "multicaDelegation:result";
export const DELEGATION_CREDENTIAL = "multicaDelegation:credential";
export const DELEGATION_SETTINGS = "multicaDelegation:settings";
export const DELEGATION_ENABLE_CLICK = "multicaDelegation:enableClick";
export const DELEGATION_SETTINGS_CHANGED = "multicaDelegation:settingsChanged";

export type DelegationDraft = {
	orchestrator: "task" | "project";
	workspaceId: string;
	profileId: string;
	runtimeId: string;
	projectId: string;
	taskId: string;
	title: string;
	brief: string;
};
export type DelegationPreview = {
	id: string; hash: string; expiresAt: number; request: DelegationDraft;
	serverKey: string; serverOrigin: string; profileName: string;
	scope: "task_brief"; policy: "policy_absent" | "policy_allowed";
};
export type DelegationConfirmationResult =
	| { ok: true; preview: DelegationPreview }
	| { ok: true; requestId: string; state: string }
	| { ok: false; code: string };
export type DelegationStatus = {
	requestId: string; projectId: string; taskId: string; workspaceId: string;
	serverOrigin: string; serverKey: string; state: string; remoteId: string | null;
	remoteTaskId: string | null; remoteStatus: string | null; terminal: boolean;
	failureCode: string | null; connection: "current" | "retrying" | "reauthentication_required" | "connection_changed";
};
export type DelegationStatusResult = { ok: true; status: DelegationStatus | null } | { ok: false; code: string };
export type DelegationCancellation = { requestId: string; remoteId: string };
export type DelegationConfirmationBridge = {
	settings: () => Promise<{ enabled: boolean }>;
	onSettingsChanged: (listener: (settings: { enabled: boolean }) => void) => () => void;
	status: (projectId: string, taskId: string) => Promise<DelegationStatusResult>;
	preview: (draft: DelegationDraft) => Promise<DelegationConfirmationResult>;
	cancelPreview: (id: string) => Promise<void>;
	setCredential: (workspaceId: string, token: string) => Promise<boolean>;
	onResult: (listener: (value: { previewId: string; result: DelegationConfirmationResult }) => void) => () => void;
};

export const delegationPolicyLabels = {
	policy_absent: "Personal selection (no managed policy)",
	policy_allowed: "Managed policy and local restrictions",
};

export const delegationStateLabels: Record<string, string> = {
	accepted: "Multica accepted this delegation.",
	cancellation_requested: "Cancellation requested. Waiting for Multica to confirm the outcome.",
	rejected: "Multica did not accept this delegation.",
	submission_unknown: "Submission outcome is unknown. Review status before trying again.",
	submitting: "Delegation submission is pending.",
	terminal: "Delegation finished.",
};

export const delegationFailureLabels: Record<string, string> = {
	cancelled: "Delegation cancelled.",
	confirmation_required: "Preview this request again before confirming.",
	preview_changed: "The request or target changed. Preview and confirm again.",
	runtime_binding_changed: "The profile’s runtime changed. Preview and confirm again.",
	policy_denied: "Policy does not allow this delegation.",
	policy_unavailable: "Policy could not be verified. Delegation is blocked.",
	policy_runtime_unknown: "Policy requires a verified runtime location.",
	policy_location_unsafe: "The policy source could not be trusted. Delegation is blocked.",
	target_unavailable: "The selected profile or runtime is unavailable.",
	connection_changed: "The configured server changed. Preview and confirm again.",
	reauthentication_required: "Sign in again with a member Public API credential to resume status checks.",
	no_token: "Configure a member Public API credential for this server and workspace first.",
	journal_conflict: "This task already has a different delegation. Review it before trying again.",
	delegations_disabled: "Delegation admission is disabled.",
	feature_disabled: "The Multica server has delegation admission disabled.",
	invocation_not_allowed: "You cannot invoke this profile.",
	runtime_unsupported: "This runtime does not support delegation.",
	journal_unavailable: "The delegation journal is unavailable. Delegation is blocked.",
};

export const delegationRemoteStatusLabels: Record<string, string> = {
	queued: "Queued", deferred: "Deferred", dispatched: "Dispatched", waiting_local_directory: "Waiting for local directory",
	running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled", unavailable: "Status unavailable",
};
