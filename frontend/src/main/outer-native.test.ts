import { createHmac } from "node:crypto";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createMainProcessDelegationAuthority } from "./multica-delegation-authority";
import { registerOuterNative } from "./outer-native";
import { OUTER_STAGE, OUTER_USER_ACTION, OUTER_CANCEL, OUTER_RESULT, installOuterUserAction, type OuterStage } from "../shared/outer-native";

function fixture() {
	const key=Buffer.alloc(32,13),authority=createMainProcessDelegationAuthority(key);
	const handlers=new Map<string,(event:IpcMainInvokeEvent,...args:unknown[])=>unknown>();
	const shell={id:11,mainFrame:{},isDestroyed:()=>false,isFocused:vi.fn(()=>true),send:vi.fn(),on:vi.fn(),removeListener:vi.fn()};
	const event={sender:{id:11},senderFrame:shell.mainFrame} as unknown as IpcMainInvokeEvent;
	let origin="http://127.0.0.1:9999";
	const submitted:Record<string,unknown>[]=[];
	const fetcher=vi.fn(async(_url:unknown,init:RequestInit)=>{
		const body=String(init.body);const proof=(init.headers as Record<string,string>)["X-AO-Delegation-MAC"];
		expect(proof).toBe(authority.outerRequestMAC(body));
		submitted.push(JSON.parse(body) as Record<string,unknown>);
		const raw=JSON.stringify({record:{state:"queued"}});
		return new Response(raw,{headers:{"X-AO-Delegation-Response-MAC":createHmac("sha256",key).update(`journal-response-v1:${proof}:${raw}`).digest("hex")}});
	});
	const registration=registerOuterNative({ipcMain:{handle:(channel,callback)=>{handlers.set(channel,callback);},removeHandler:vi.fn()},shellWebContents:shell as unknown as WebContents,authority,origin:()=>origin,fetch:fetcher as typeof fetch});
	const stage=async(draft:unknown={operation:"send",sessionId:"outer-session",text:"Inspect selected reports"})=>await handlers.get(OUTER_STAGE)!(event,"composer",draft) as OuterStage;
	return {handlers,shell,event,submitted,fetcher,stage,registration,setOrigin:(value:string)=>{origin=value;}};
}

describe("outer native human issuance",()=>{
	it("stages inert data, freezes exact content and issues one request only on a focused action",async()=>{
		const f=fixture();const draft={operation:"send",sessionId:"outer-session",text:"Original human request"};const s=await f.stage(draft);draft.text="changed";
		expect(f.submitted).toEqual([]);
		const click={id:s.id,digest:s.digest};
		await f.handlers.get(OUTER_USER_ACTION)!({...f.event,senderFrame:{}} as IpcMainInvokeEvent,click);
		f.shell.isFocused.mockReturnValue(false);await f.handlers.get(OUTER_USER_ACTION)!(f.event,click);f.shell.isFocused.mockReturnValue(true);
		await f.handlers.get(OUTER_USER_ACTION)!(f.event,{...click,approval:"forged"});
		await f.handlers.get(OUTER_USER_ACTION)!(f.event,{...click,digest:"a".repeat(64)});
		expect(f.submitted).toEqual([]);
		await f.handlers.get(OUTER_USER_ACTION)!(f.event,click);await f.handlers.get(OUTER_USER_ACTION)!(f.event,click);
		expect(f.submitted).toHaveLength(1);expect(f.submitted[0]).toMatchObject({operation:"send",sessionId:"outer-session",text:"Original human request",id:s.id});
		expect(f.shell.send).toHaveBeenCalledWith(OUTER_RESULT,{id:s.id,ok:true,uncertain:false,record:{state:"queued"}});
	});
	it.each(["replacement","cancel","navigation","origin","expiry"])("rejects a stale stage after %s",async(mode)=>{
		vi.useFakeTimers();try{
			const f=fixture();const s=await f.stage();
			if(mode==="replacement")await f.stage({operation:"send",sessionId:"outer-session",text:"New request"});
			if(mode==="cancel")await f.handlers.get(OUTER_CANCEL)!(f.event,s.id);
			if(mode==="navigation")f.registration.invalidate();
			if(mode==="origin")f.setOrigin("http://127.0.0.1:9998");
			if(mode==="expiry")vi.advanceTimersByTime(120_001);
			await f.handlers.get(OUTER_USER_ACTION)!(f.event,{id:s.id,digest:s.digest});expect(f.submitted).toEqual([]);
		}finally{vi.useRealTimers();}
	});
	it("does not resend after an ambiguous transport result",async()=>{
		const f=fixture();const s=await f.stage();f.fetcher.mockRejectedValue(new Error("lost response"));
		await f.handlers.get(OUTER_USER_ACTION)!(f.event,{id:s.id,digest:s.digest});await f.handlers.get(OUTER_USER_ACTION)!(f.event,{id:s.id,digest:s.digest});
		expect(f.fetcher).toHaveBeenCalledOnce();expect(f.shell.send).toHaveBeenCalledWith(OUTER_RESULT,{id:s.id,ok:false,uncertain:true});
	});
	it("has no arbitrary URL, signer, raw authority or generic operation bridge",async()=>{
		const f=fixture();
		for(const bad of [{operation:"sign",body:"anything"},{operation:"send",sessionId:"s",text:"x",userAuthored:true},{operation:"control",control:{action:"raw",targetId:"s",body:{url:"/send"}}}])expect(await f.stage(bad)).toBeNull();
		expect([...f.handlers.keys()].sort()).toEqual([OUTER_STAGE,OUTER_CANCEL,OUTER_USER_ACTION].sort());
	});
	it("does not turn scripted DOM clicks or Enter into a native human action",()=>{
		const invoke=vi.fn(async()=>undefined);installOuterUserAction(document,invoke);
		const button=document.createElement("button");button.dataset.outerStageId="forged";button.dataset.outerStageDigest="forged";document.body.append(button);button.click();
		button.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));expect(invoke).not.toHaveBeenCalled();button.remove();
	});
});
