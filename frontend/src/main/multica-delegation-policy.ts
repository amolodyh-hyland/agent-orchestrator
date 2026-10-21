import type { PublicApiBinding } from "./multica-public-api";

export type DelegationRuntimeClass = "local" | "remote" | "unknown";
export type DelegationPolicyBlockCode = "policy_denied" | "policy_unavailable" | "policy_runtime_unknown";
export type DelegationPolicyRequest = Readonly<{
	serverOrigin: string; workspaceId: string; profileId: string; runtimeId: string;
	runtimeClass: DelegationRuntimeClass; dataScopes: readonly ["task_brief"]; action: "delegate";
}>;
export type DelegationPolicyResolver = (request: DelegationPolicyRequest) => Promise<unknown>;
export type DelegationRuntimeResolver = (binding: PublicApiBinding, runtimeId: string) => Promise<DelegationRuntimeClass>;

async function withPolicyDeadline<T>(operation: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation(),
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("policy_unavailable")), 5000); }),
		]);
	} finally { if (timer) clearTimeout(timer); }
}

export async function resolveDelegationRuntime(resolver: DelegationRuntimeResolver | undefined, binding: PublicApiBinding, runtimeId: string): Promise<DelegationRuntimeClass> {
	if (!resolver) return "unknown";
	try {
		const value = await withPolicyDeadline(() => resolver({ ...binding }, runtimeId));
		return value === "local" || value === "remote" ? value : "unknown";
	} catch { return "unknown"; }
}

export async function policyBlock(resolver: DelegationPolicyResolver, request: DelegationPolicyRequest): Promise<DelegationPolicyBlockCode | null> {
	try {
		const value = await withPolicyDeadline(() => resolver(request));
		if (!value || typeof value !== "object" || Object.keys(value).length !== 1 || !("code" in value)) return "policy_unavailable";
		switch (value.code) {
			case "policy_absent": case "policy_allowed": return null;
			case "policy_denied": case "policy_runtime_unknown": return value.code;
			default: return "policy_unavailable";
		}
	} catch { return "policy_unavailable"; }
}
