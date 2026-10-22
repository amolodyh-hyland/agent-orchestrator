import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMainProcessDelegationAuthority } from "./multica-delegation-authority";
import { createMulticaDelegationCoordinator, type DelegationRecord, type DelegationJournal } from "./multica-delegation-coordinator";

async function fixture(): Promise<DelegationRecord> {
	return JSON.parse(await readFile(path.resolve(process.cwd(), "../backend/internal/delegationauth/testdata/record.json"), "utf8"));
}
describe("private human confirmation capability", () => {
	it("binds the proof to the nonce, target, payload digest, principal, and rerun", async () => {
		const authority = createMainProcessDelegationAuthority(Buffer.alloc(32, 7));
		const record = await fixture();
		const proof = authority.confirmationProof(record);
		expect(proof).toMatch(/^[0-9a-f]{64}$/);
		for (const changed of [
			{ ...record, requestId: "changed" }, { ...record, confirmedBy: "another-human" }, { ...record, confirmedAt: "2026-10-22T12:00:00Z" },
			{ ...record, payloadHash: "changed" }, { ...record, rerunOf: "another-request" },
			{ ...record, intent: { ...record.intent, binding: { ...record.intent.binding, origin: "https://other.example" } } },
		]) expect(authority.confirmationProof(changed)).not.toBe(proof);
		expect(createMainProcessDelegationAuthority(Buffer.alloc(32, 8)).confirmationProof(record)).not.toBe(proof);
		expect(JSON.stringify(authority)).toBe("{}");
	});
	it("exposes no confirmation or cancellation issuer to orchestrator handles", async () => {
		const r = await fixture();
		const journal: DelegationJournal = { evaluatePolicy: async () => ({ code: "policy_absent" }), get: async () => r, find: async () => r, reserve: async () => { throw new Error("must not mint"); }, save: async () => { throw new Error("must not mutate"); } };
		const services = createMulticaDelegationCoordinator({ journal, client: () => { throw new Error("must not connect"); }, confirmations: createMainProcessDelegationAuthority(Buffer.alloc(32, 7)) });
		expect(services.taskOrchestrator).toBe(services.projectOrchestrator);
		for (const handle of [services.taskOrchestrator, services.projectOrchestrator]) {
			expect(Object.keys(handle).sort()).toEqual(["process", "processTask", "reconcile"]);
			expect(() => Reflect.get(handle, "confirmFromUserAction")({ forged: true })).toThrow();
		}
	});
	it("registers no HTTP or IPC confirmation issuer and hands off the key only on stdin", async () => {
		const main = await readFile(path.resolve(process.cwd(), "src/main.ts"), "utf8");
		const preload = await readFile(path.resolve(process.cwd(), "src/preload.ts"), "utf8");
		expect(main).not.toMatch(/ipcMain\.(?:handle|on)\([^\n]*(?:delegation|confirmation)/i);
		expect(preload).not.toMatch(/delegationConfirmation|confirmFromUserAction|confirmationProof|requestMAC/);
		expect(main).toContain('delegationKey: delegationConfirmation.key.toString("base64url")');
		expect(main).not.toMatch(/AO_\w+\s*:\s*delegationConfirmation/);
	});
	it("rejects unknown fields in the private human API before writing a proof", async () => {
		const r = await fixture();
		let writes = 0;
		const journal: DelegationJournal = { evaluatePolicy: async () => ({ code: "policy_absent" }), get: async () => null, find: async () => null, reserve: async () => { writes++; return r; }, save: async () => r };
		const human = createMulticaDelegationCoordinator({ journal, client: () => { throw new Error("must not connect"); }, confirmations: createMainProcessDelegationAuthority(Buffer.alloc(32, 7)) }).human;
		const approved = { id: "human-action", userId: "user-1", at: "2026-10-21T12:00:00Z" };
		const unknown = { ...r.intent, binding: { ...r.intent.binding, hidden: "unapproved" } };
		await expect(human.confirmFromUserAction(unknown, approved)).rejects.toThrow("invalid_request");
		await expect(human.confirmFromUserAction(r.intent, { ...approved, hidden: "unapproved" } as typeof approved)).rejects.toThrow("confirmation_required");
		expect(writes).toBe(0);
	});

});
