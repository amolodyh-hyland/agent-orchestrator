import { createHash } from "node:crypto";
import { object, text, uuid, type PublicDelegation } from "./multica-public-api-model";

export const MAX_RESULT_BYTES = 32768;
export type PublicDelegationResult = {
 version: 1; format: "text/plain"; delegation_id: string; task_id: string; workspace_id: string; agent_id: string; runtime_id: string;
 status: "completed" | "failed" | "cancelled"; terminal_revision: string; completed_at: string; revision: string; digest: string; byte_count: number; text: string;
};
export function resultText(value: unknown): string {
 const s = text(value, MAX_RESULT_BYTES);
 if (!s.trim() || /[\\/\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(s) || /(?:www\.|(?:https?|ftp|file|data|javascript|mailto|ssh|smb|tel):|(?:mul_|mat_|mcn_|mpi_|mpc_|ghp_|github_pat_|sk-)[a-z0-9_-]+|-----BEGIN|\b(?:bearer|password|passwd|secret|api[_ -]?key|access[_ -]?token)\s*[:= ]\s*\S+)/i.test(s) || Buffer.from(s).toString("utf8") !== s) throw new Error("unsafe result");
 return s;
}
export const resultHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function delegationResult(value: unknown, expected: PublicDelegation): PublicDelegationResult {
 const v = object(value);
 const digest = (x: unknown) => { const s = text(x, 64); if (!/^[a-f0-9]{64}$/.test(s)) throw new Error("invalid digest"); return s; };
 if (v.version !== 1 || v.format !== "text/plain" || !expected.terminal || !["completed", "failed", "cancelled"].includes(expected.status)) throw new Error("invalid terminal result");
 const r: PublicDelegationResult = { version: 1, format: "text/plain", delegation_id: uuid(v.delegation_id), task_id: uuid(v.task_id), workspace_id: uuid(v.workspace_id), agent_id: uuid(v.agent_id), runtime_id: uuid(v.runtime_id), status: expected.status as PublicDelegationResult["status"], terminal_revision: digest(v.terminal_revision), completed_at: text(v.completed_at,64), revision: "", digest: digest(v.digest), byte_count: Number(v.byte_count), text: resultText(v.text) };
 if (Object.keys(v).length !== Object.keys(r).length || ["delegation_id","task_id","workspace_id","agent_id","runtime_id","status"].some(k => v[k] !== expected[k as keyof PublicDelegation]) || r.terminal_revision !== expected.revision || !/^\d{4}-\d\d-\d\dT/.test(r.completed_at) || !Number.isFinite(Date.parse(r.completed_at)) || r.byte_count !== Buffer.byteLength(r.text) || r.digest !== resultHash(r.text)) throw new Error("result identity or digest mismatch");
 const revision = digest(v.revision);
 // Match Go's JSON string escaping in the versioned snapshot contract.
 const serialized = JSON.stringify(r).replace(/</g,"\\u003c").replace(/>/g,"\\u003e").replace(/&/g,"\\u0026").replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
 if (resultHash(serialized) !== revision) throw new Error("result snapshot mismatch");
 r.revision = revision;
 return r;
}
