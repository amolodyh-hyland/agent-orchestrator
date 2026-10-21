export type PublicAgent = {
	agent_id: string;
	workspace_id: string;
	name: string;
	runtime_id: string;
	runtime_bound: boolean;
	permission_mode: string;
	can_invoke: boolean;
	invocation_targets: Array<{ target_type: string; target_id: string | null }>;
	archived: boolean;
	availability: "online" | "unstable" | "offline" | "unbound" | "unavailable" | "archived";
};

export type PublicRuntime = {
	runtime_id: string;
	workspace_id: string;
	availability: "online" | "unstable" | "offline";
};

export type PublicDelegation = {
	delegation_id: string;
	task_id: string;
	workspace_id: string;
	agent_id: string;
	runtime_id: string;
	status: "queued" | "deferred" | "dispatched" | "waiting_local_directory" | "running" | "completed" | "failed" | "cancelled" | "unavailable";
	created_at: string;
	terminal: boolean;
	revision: string;
	failure_reason?: "access_revoked" | "target_unavailable" | "timeout" | "runtime_unavailable" | "execution_failed" | "execution_cancelled" | "execution_unavailable";
};

export type CreatePublicDelegation = {
	agent_id: string;
	expected_runtime_id: string;
	source: { system: string; project_id: string; task_id: string };
	task: { title: string; instructions: string };
};

export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
	return value as Record<string, unknown>;
}

export function text(value: unknown, maxBytes = 4096): string {
	if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) throw new Error("invalid string");
	return value;
}

export function uuid(value: unknown): string {
	const id = text(value, 36).toLowerCase();
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id)) throw new Error("invalid id");
	return id;
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error("invalid boolean");
	return value;
}

function choice<const T extends string>(value: unknown, values: readonly T[]): T {
	if (!values.includes(value as T)) throw new Error("invalid value");
	return value as T;
}

export function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
	if (!Array.isArray(value) || value.length > 200) throw new Error("invalid list");
	return value.map(parse);
}

function workspace(value: unknown, expected: string): string {
	const id = uuid(value);
	if (id !== expected) throw new Error("workspace mismatch");
	return id;
}

export function agent(value: unknown, workspaceId: string): PublicAgent {
	const v = object(value);
	return {
		agent_id: uuid(v.agent_id), workspace_id: workspace(v.workspace_id, workspaceId), name: text(v.name),
		runtime_id: v.runtime_id === "" ? "" : uuid(v.runtime_id), runtime_bound: boolean(v.runtime_bound),
		permission_mode: text(v.permission_mode), can_invoke: boolean(v.can_invoke), archived: boolean(v.archived),
		availability: choice(v.availability, ["online", "unstable", "offline", "unbound", "unavailable", "archived"]),
		invocation_targets: array(v.invocation_targets, (item) => {
			const target = object(item);
			return { target_type: text(target.target_type), target_id: target.target_id === null ? null : uuid(target.target_id) };
		}),
	};
}

export function runtime(value: unknown, workspaceId: string): PublicRuntime {
	const v = object(value);
	return {
		runtime_id: uuid(v.runtime_id), workspace_id: workspace(v.workspace_id, workspaceId),
		availability: choice(v.availability, ["online", "unstable", "offline"]),
	};
}

export function delegation(value: unknown, workspaceId: string): PublicDelegation {
	const v = object(value);
	const createdAt = text(v.created_at, 64);
	if (!/^\d{4}-\d\d-\d\dT/.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) throw new Error("invalid timestamp");
	const status = choice(v.status, ["queued", "deferred", "dispatched", "waiting_local_directory", "running", "completed", "failed", "cancelled", "unavailable"]);
	const terminal = boolean(v.terminal);
	if (terminal !== ["completed", "failed", "cancelled"].includes(status)) throw new Error("invalid terminal state");
	const revision = text(v.revision, 255);
	if (!/^[\x21\x23-\x7e]+$/.test(revision)) throw new Error("invalid revision");
	return {
		delegation_id: uuid(v.delegation_id), task_id: uuid(v.task_id), workspace_id: workspace(v.workspace_id, workspaceId),
		agent_id: uuid(v.agent_id), runtime_id: uuid(v.runtime_id), created_at: createdAt,
		status, terminal, revision,
		...(v.failure_reason === undefined ? {} : { failure_reason: choice(v.failure_reason, ["access_revoked", "target_unavailable", "timeout", "runtime_unavailable", "execution_failed", "execution_cancelled", "execution_unavailable"]) }),
	};
}

export function createDelegation(value: CreatePublicDelegation): CreatePublicDelegation {
	const required = (v: unknown, max: number): string => {
		const s = text(v, max);
		if (!s.trim()) throw new Error("empty string");
		return s;
	};
	return {
		agent_id: uuid(value.agent_id), expected_runtime_id: uuid(value.expected_runtime_id),
		source: { system: required(value.source.system, 64), project_id: required(value.source.project_id, 255), task_id: required(value.source.task_id, 255) },
		task: { title: required(value.task.title, 512), instructions: required(value.task.instructions, 65536) },
	};
}
