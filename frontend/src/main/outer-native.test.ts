import { createHmac } from "node:crypto";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createMainProcessDelegationAuthority } from "./multica-delegation-authority";
import { registerOuterNative } from "./outer-native";
import {
	OUTER_STAGE,
	OUTER_USER_ACTION,
	OUTER_CANCEL,
	OUTER_RESULT,
	OUTER_READ,
	installOuterUserAction,
	type OuterStage,
} from "../shared/outer-native";

describe("finite desktop control staging", () => {
	it("freezes the exact route and body without issuing until a trusted private gesture", async () => {
		const f = fixture();
		try {
			const draft = {
				operation: "control",
				control: {
					action: "desktop.control",
					targetId: "",
					body: {
						route: "PUT /api/v1/projects/{id}",
						parameters: ["project-a"],
						query: "",
						payload: {
							displayName: "Exact human draft",
							config: {},
						},
						attachmentUpload: false,
					},
				},
			};
			const stage = await f.stage(draft);
			expect(stage.id).toBeTruthy();
			expect(f.submitted).toHaveLength(0);
			draft.control.body.parameters[0] = "project-b";
			draft.control.body.payload.displayName = "Altered";
			await f.handlers.get(OUTER_USER_ACTION)!(f.event, {
				id: stage.id,
				digest: stage.digest,
			});
			expect(f.submitted).toMatchObject([
				{
					operation: "control",
					control: {
						body: {
							parameters: ["project-a"],
							payload: { displayName: "Exact human draft" },
						},
					},
				},
			]);
		} finally {
			f.registration.dispose();
		}
	});

	it("rejects arbitrary routes, headers, ownership overrides and held interfaces", async () => {
		const f = fixture();
		try {
			const body = {
				route: "PUT /api/v1/projects/{id}",
				parameters: ["a"],
				query: "",
				payload: {},
				attachmentUpload: false,
			};
			for (const change of [
				{ route: "POST https://example.invalid/send" },
				{ route: "POST /internal/outer/native" },
				{ parameters: ["../a"] },
				{ parameters: ["a/b"] },
				{ parameters: ["a", "b"] },
				{ headers: { "X-AO-Scope-Credential": "forged" } },
				{ operation: "outer.send" },
				{
					route: "POST /api/v1/sessions/{sessionId}/conversation/prompt-suggestion",
				},
			])
				expect(
					await f.stage({
						operation: "control",
						control: {
							action: "desktop.control",
							targetId: "",
							body: { ...body, ...change },
						},
					})
				).toBeNull();
			expect(
				await f.stage({
					operation: "control",
					control: {
						action: "desktop.control",
						targetId: "claimed-owner",
						body,
					},
				})
			).toBeNull();
			expect(f.submitted).toHaveLength(0);
		} finally {
			f.registration.dispose();
		}
	});
});

function fixture(options: {confirmPlan?: (detail:string)=>Promise<boolean>; view?: unknown} = {}) {
	const key = Buffer.alloc(32, 13),
		authority = createMainProcessDelegationAuthority(key);
	const handlers = new Map<
		string,
		(event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
	>();
	const shell = {
		id: 11,
		mainFrame: {},
		isDestroyed: () => false,
		isFocused: vi.fn(() => true),
		send: vi.fn(),
		on: vi.fn(),
		removeListener: vi.fn(),
	};
	const event = {
		sender: { id: 11 },
		senderFrame: shell.mainFrame,
	} as unknown as IpcMainInvokeEvent;
	let origin = "http://127.0.0.1:9999";
	const submitted: Record<string, unknown>[] = [];
	const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
		const body = String(init.body);
		const proof = (init.headers as Record<string, string>)[
			"X-AO-Delegation-MAC"
		];
		const reading = String(_url).endsWith("/internal/outer/read");
		expect(proof).toBe(
			reading
				? authority.outerReadRequestMAC(body)
				: authority.outerRequestMAC(body)
		);
		submitted.push(JSON.parse(body) as Record<string, unknown>);
		const query = JSON.parse(body) as { projection?: string };
		const raw = JSON.stringify({
			record: reading
				? { projection: query.projection, data: options.view ?? { observed: true } }
				: { state: "queued" },
		});
		return new Response(raw, {
			headers: {
				"X-AO-Delegation-Response-MAC": createHmac("sha256", key)
					.update(`journal-response-v1:${proof}:${raw}`)
					.digest("hex"),
			},
		});
	});
	const registration = registerOuterNative({
		ipcMain: {
			handle: (channel, callback) => {
				handlers.set(channel, callback);
			},
			removeHandler: vi.fn(),
		},
		shellWebContents: shell as unknown as WebContents,
		authority,
		origin: () => origin,
		fetch: fetcher as typeof fetch,
		confirmPlan: options.confirmPlan,
	});
	const stage = async (
		draft: unknown = {
			operation: "send",
			expected: {
				bindingRevision: 1,
				scopeRevision: 1,
				controllerGeneration: "generation-1",
				settingsDigest: "a".repeat(64),
			},
			sessionId: "outer-session",
			text: "Inspect selected reports",
		}
	) =>
		(await handlers.get(OUTER_STAGE)!(
			event,
			"composer",
			draft
		)) as OuterStage;
	return {
		handlers,
		authority,
		key,
		shell,
		event,
		submitted,
		fetcher,
		stage,
		registration,
		setOrigin: (value: string) => {
			origin = value;
		},
	};
}

describe("outer native human issuance", () => {
	it("stages inert data, freezes exact content and issues one request only on a focused action", async () => {
		const f = fixture();
		const draft = {
			operation: "send",
			expected: {
				bindingRevision: 1,
				scopeRevision: 1,
				controllerGeneration: "generation-1",
				settingsDigest: "a".repeat(64),
			},
			sessionId: "outer-session",
			text: "Original human request",
		};
		const s = await f.stage(draft);
		draft.text = "changed";
		draft.expected.scopeRevision = 99;
		expect(f.submitted).toEqual([]);
		const click = { id: s.id, digest: s.digest };
		await f.handlers.get(OUTER_USER_ACTION)!(
			{ ...f.event, senderFrame: {} } as IpcMainInvokeEvent,
			click
		);
		f.shell.isFocused.mockReturnValue(false);
		await f.handlers.get(OUTER_USER_ACTION)!(f.event, click);
		f.shell.isFocused.mockReturnValue(true);
		await f.handlers.get(OUTER_USER_ACTION)!(f.event, {
			...click,
			approval: "forged",
		});
		await f.handlers.get(OUTER_USER_ACTION)!(f.event, {
			...click,
			digest: "a".repeat(64),
		});
		expect(f.submitted).toEqual([]);
		await f.handlers.get(OUTER_USER_ACTION)!(f.event, click);
		await f.handlers.get(OUTER_USER_ACTION)!(f.event, click);
		expect(f.submitted).toHaveLength(1);
		expect(f.submitted[0]).toMatchObject({
			operation: "send",
			expected: {
				bindingRevision: 1,
				scopeRevision: 1,
				controllerGeneration: "generation-1",
				settingsDigest: "a".repeat(64),
			},
			sessionId: "outer-session",
			text: "Original human request",
			id: s.id,
		});
		expect(f.shell.send).toHaveBeenCalledWith(OUTER_RESULT, {
			id: s.id,
			ok: true,
			uncertain: false,
			record: { state: "queued" },
		});
	});
	it.each(["replacement", "cancel", "navigation", "origin", "expiry"])(
		"rejects a stale stage after %s",
		async (mode) => {
			vi.useFakeTimers();
			try {
				const f = fixture();
				const s = await f.stage();
				if (mode === "replacement")
					await f.stage({
						operation: "send",
						expected: {
							bindingRevision: 1,
							scopeRevision: 1,
							controllerGeneration: "generation-1",
							settingsDigest: "a".repeat(64),
						},
						sessionId: "outer-session",
						text: "New request",
					});
				if (mode === "cancel")
					await f.handlers.get(OUTER_CANCEL)!(f.event, s.id);
				if (mode === "navigation") f.registration.invalidate();
				if (mode === "origin") f.setOrigin("http://127.0.0.1:9998");
				if (mode === "expiry") vi.advanceTimersByTime(120_001);
				await f.handlers.get(OUTER_USER_ACTION)!(f.event, {
					id: s.id,
					digest: s.digest,
				});
				expect(f.submitted).toEqual([]);
			} finally {
				vi.useRealTimers();
			}
		}
	);
	it("does not resend after an ambiguous transport result", async () => {
		const f = fixture();
		const s = await f.stage();
		f.fetcher.mockRejectedValue(new Error("lost response"));
		await f.handlers.get(OUTER_USER_ACTION)!(f.event, {
			id: s.id,
			digest: s.digest,
		});
		await f.handlers.get(OUTER_USER_ACTION)!(f.event, {
			id: s.id,
			digest: s.digest,
		});
		expect(f.fetcher).toHaveBeenCalledOnce();
		expect(f.shell.send).toHaveBeenCalledWith(OUTER_RESULT, {
			id: s.id,
			ok: false,
			uncertain: true,
		});
	});
	it("has no arbitrary URL, signer, raw authority or generic operation bridge", async () => {
		const f = fixture();
		for (const bad of [
			{ operation: "sign", body: "anything" },
			{
				operation: "send",
				expected: {
					bindingRevision: 1,
					scopeRevision: 1,
					controllerGeneration: "generation-1",
					settingsDigest: "a".repeat(64),
				},
				sessionId: "s",
				text: "x",
				userAuthored: true,
			},
			{
				operation: "control",
				control: {
					action: "raw",
					targetId: "s",
					body: { url: "/send" },
				},
			},
		])
			expect(await f.stage(bad)).toBeNull();
		expect([...f.handlers.keys()].sort()).toEqual(
			[OUTER_STAGE, OUTER_CANCEL, OUTER_USER_ACTION, OUTER_READ].sort()
		);
	});
	it("does not turn scripted DOM clicks or Enter into a native human action", () => {
		const invoke = vi.fn(async () => undefined);
		installOuterUserAction(document, invoke);
		const button = document.createElement("button");
		button.dataset.outerStageId = "forged";
		button.dataset.outerStageDigest = "forged";
		document.body.append(button);
		button.click();
		button.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
		);
		expect(invoke).not.toHaveBeenCalled();
		button.remove();
	});
});

describe("trusted passive outer projections", () => {
	it("binds a bounded affected-Project audit filter to its private read", async () => {
		const f = fixture();
		expect(
			await f.handlers.get(OUTER_READ)!(f.event, {
				projection: "audit",
				projectId: "removed-project",
				after: 4,
				limit: 20,
			})
		).not.toBeNull();
		expect(f.submitted[0]).toMatchObject({
			projection: "audit",
			projectId: "removed-project",
			after: 4,
			limit: 20,
		});
		expect(f.shell.send).not.toHaveBeenCalled();
	});
	it("uses only the private read purpose and grants no Send authority", async () => {
		const f = fixture();
		f.shell.isFocused.mockReturnValue(false);
		const result = await f.handlers.get(OUTER_READ)!(f.event, {
			projection: "view",
		});
		expect(result).toEqual({
			projection: "view",
			data: { observed: true },
		});
		expect(f.submitted).toHaveLength(1);
		expect(f.submitted[0]).toEqual({
			projection: "view",
			nonce: expect.any(String),
			expires: expect.any(Number),
		});
		expect(f.shell.send).not.toHaveBeenCalled();
		expect(f.fetcher.mock.calls[0][0]).toBe(
			"http://127.0.0.1:9999/internal/outer/read"
		);
		const proof = (
			f.fetcher.mock.calls[0][1].headers as Record<string, string>
		)["X-AO-Delegation-MAC"];
		expect(proof).not.toBe(
			f.authority.outerRequestMAC(String(f.fetcher.mock.calls[0][1].body))
		);
	});

	it("rejects other senders, subframes, oversized projections and generic URL requests", async () => {
		const f = fixture();
		for (const event of [
			{ ...f.event, sender: { id: 12 } },
			{ ...f.event, senderFrame: {} },
		]) {
			expect(
				await f.handlers.get(OUTER_READ)!(event as IpcMainInvokeEvent, {
					projection: "view",
				})
			).toBeNull();
		}
		for (const query of [
			{ projection: "view", operation: "send" },
			{ projection: "view", path: "/api/v1/sessions" },
			{ projection: "facts", projectId: "a", kind: "files", limit: 1 },
			{ projection: "facts", projectId: "a", kind: "reports", limit: 51 },
			{ projection: "audit", after: -1, limit: 100 },
			{ projection: "audit", after: 0, limit: 101 },
			{ projection: "audit", projectId: "", after: 0, limit: 20 },
		])
			expect(
				await f.handlers.get(OUTER_READ)!(f.event, query)
			).toBeNull();
		expect(f.fetcher).not.toHaveBeenCalled();
	});

	it.each(["navigation", "origin", "bad-response"])(
		"holds stale or unverified passive data after %s",
		async (reason) => {
			const f = fixture();
			let finish!: (value: Response) => void;
			f.fetcher.mockImplementationOnce(
				() =>
					new Promise<Response>((resolve) => {
						finish = resolve;
					})
			);
			const reading = f.handlers.get(OUTER_READ)!(f.event, {
				projection: "audit",
				after: 0,
				limit: 20,
			});
			const init = f.fetcher.mock.calls[0][1];
			const proof = (init.headers as Record<string, string>)[
				"X-AO-Delegation-MAC"
			];
			const raw = JSON.stringify({
				record: { projection: "audit", data: { events: [] } },
			});
			const mac = createHmac("sha256", f.key)
				.update(`journal-response-v1:${proof}:${raw}`)
				.digest("hex");
			if (reason === "navigation") f.registration.invalidate();
			if (reason === "origin") f.setOrigin("http://127.0.0.1:9998");
			finish(
				new Response(raw, {
					headers: {
						"X-AO-Delegation-Response-MAC":
							reason === "bad-response" ? "forged" : mac,
					},
				})
			);
			expect(await reading).toBeNull();
			expect(f.shell.send).not.toHaveBeenCalled();
		}
	);
});


describe("exact outer plan confirmation",()=>{
 const planId="exact-sealed-plan-id", digest="a".repeat(64);
 const view={actionsEnabled:true,plans:[{digest,approvedAt:"0001-01-01T00:00:00Z",expiresAt:"0001-01-01T00:00:00Z",plan:{id:planId,request:{humanMessage:"Send to the named coordinator and start this worker",sessionId:"outer-1",controllerGeneration:"outer-generation",scopeRevision:3},sources:[{projectId:"A",label:"Source A",unknown:true,sources:["A","B"]}],actions:[{id:"send-once",spec:{operation:"send",projectId:"B",sessionId:"B-coordinator",text:"Exact disclosed message"},controllerGeneration:"target-generation"},{id:"spawn-once",spec:{operation:"spawn",projectId:"B",branch:"feat/exact-worker",text:"Exact worker task"}}]}}]};
 it("shows one authoritative complete manifest and submits its exact digest once",async()=>{
  const confirm=vi.fn(async(detail:string)=>{expect(detail).toContain("Exact disclosed message");expect(detail).toContain("Exact worker task");expect(detail).toContain("Source A");expect(detail).toContain('"operationCount": 2');return true;});
  const f=fixture({confirmPlan:confirm,view});
  try { const stage=await f.stage({operation:"plan",planId,digest}); expect(f.submitted).toHaveLength(0);
   const click={id:stage.id,digest:stage.digest}; await f.handlers.get(OUTER_USER_ACTION)!(f.event,click); await f.handlers.get(OUTER_USER_ACTION)!(f.event,click);
   expect(confirm).toHaveBeenCalledTimes(1);expect(f.submitted.filter(x=>x.operation)).toMatchObject([{operation:"plan",planId,digest}]);
  }finally{f.registration.dispose();}
 });
 it.each(["cancel","mismatched digest","stale renderer","expired"])("holds %s without an action approval",async(mode)=>{
  let invalidate=()=>{};
  const confirm=vi.fn(async()=>{if(mode==="stale renderer")invalidate();if(mode==="expired")vi.spyOn(Date,"now").mockReturnValue(Date.now()+180000);return mode!=="cancel";});
  const f=fixture({confirmPlan:confirm,view});invalidate=f.registration.invalidate;
  try {const stage=await f.stage({operation:"plan",planId,digest:mode==="mismatched digest"?"b".repeat(64):digest});await f.handlers.get(OUTER_USER_ACTION)!(f.event,{id:stage.id,digest:stage.digest});
   expect(f.submitted.filter(x=>x.operation==="plan")).toHaveLength(0);if(mode==="cancel")expect(f.submitted.filter(x=>x.operation)).toMatchObject([{operation:"plan.cancel",planId,digest}]);
  }finally{vi.restoreAllMocks();f.registration.dispose();}
 });
 it("rejects caller supplied approval, manifest and wildcard fields",async()=>{
  const f=fixture({view});try{for(const extra of [{approved:true},{actions:["*"]},{humanAuthored:true},{authority:"forged"}])expect(await f.stage({operation:"plan",planId,digest,...extra})).toBeNull();expect(f.submitted).toHaveLength(0);}finally{f.registration.dispose();}
 });
});
