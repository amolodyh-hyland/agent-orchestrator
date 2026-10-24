import { createHmac, timingSafeEqual } from "node:crypto";
import type { DelegationRecord } from "./multica-delegation-coordinator";

// Constructed only by Electron's composition root. Neither this object nor its key
// is registered with IPC, preload, HTTP, sessions, MCP, or persisted settings.
export function createMainProcessDelegationAuthority(secret: Uint8Array) {
	if (secret.byteLength !== 32) throw new Error("invalid_delegation_authority");
	const key = Buffer.from(secret);
	const mac = (subject: string) => createHmac("sha256", key).update(subject).digest("hex");
	return Object.freeze({
		outerRequestMAC: (body: string) => mac(`outer-native-v1:${body}`),
		outerReadRequestMAC: (body: string) => mac(`outer-read-v1:${body}`),
		runRequestMAC: (body: string) => mac(`factory-run-v1:${body}`),
		requestMAC: (body: string) => mac(`journal-v1:${body}`),
		verifyResponseMAC: (body: string, requestMAC: string, proof: string | null) => {
			if (!proof || !/^[0-9a-f]{64}$/.test(proof)) return false;
			return timingSafeEqual(Buffer.from(mac(`journal-response-v1:${requestMAC}:${body}`), "hex"), Buffer.from(proof, "hex"));
		},
		confirmationProof: (r: DelegationRecord) => {
			const { binding, payload } = r.intent;
			const values = [r.requestId, r.projectId, r.taskId, r.confirmationId, r.confirmedBy, r.confirmedAt, r.rerunOf,
				binding.serverKey, binding.origin, binding.workspaceId, payload.agent_id, payload.expected_runtime_id, r.payloadHash];
			return mac(`confirmation-v1:${values.map((v) => `${Buffer.byteLength(v)}:${v}`).join("")}`);
		},
	});
}
export type MainProcessDelegationAuthority = ReturnType<typeof createMainProcessDelegationAuthority>;
