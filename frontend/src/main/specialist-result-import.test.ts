// @vitest-environment node
import type { DelegationPolicyRequest } from "./multica-delegation-policy";
import { createHmac } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import { createMainProcessDelegationAuthority } from "./multica-delegation-authority";
import { RESULT_PREVIEW, RESULT_CLICK } from "../shared/specialist-result";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMulticaPublicApi } from "./multica-public-api";
import { delegationResult, resultText } from "./multica-result-model";
import { createResultImportFlow, registerResultImport, type ResultContext } from "./specialist-result-import";
import type { MulticaCredentials } from "./multica-credentials";
import type { PublicDelegation } from "./multica-public-api-model";
import { resolveMulticaServer } from "../shared/multica";
const raw=readFileSync(resolve(process.cwd(),"../test/contracts/multica-delegation-result-v1.json"),"utf8");
const wire=JSON.parse(raw).result;
const remote:PublicDelegation={delegation_id:wire.delegation_id,task_id:wire.task_id,workspace_id:wire.workspace_id,agent_id:wire.agent_id,runtime_id:wire.runtime_id,status:wire.status,terminal:true,revision:wire.terminal_revision,created_at:"2026-10-24T00:00:00Z"};
function setup(){
 const server=resolveMulticaServer({mode:"local",customUrl:"http://127.0.0.1:4444",apiUrl:"http://127.0.0.1:4444"})!;
 let now=Date.now(),current=true,enabled=true,code="",data:unknown=structuredClone(wire);const events:string[]=[];
 const credentials={resolve:vi.fn(async()=>({ok:true,token:"mul_fixture_pat"}))} as unknown as MulticaCredentials;
 const fetcher=vi.fn(async(url:unknown,init:RequestInit)=>{events.push("read");expect(String(url)).toContain(`/delegations/${wire.delegation_id}/result`);expect(init.method).toBe("GET");expect((init.headers as Record<string,string>)["If-Match"]).toBe(`"${remote.revision}"`);return code?Response.json({type:"problem",title:"Problem",status:code==="invalid_token"?401:409,code,detail:"private",request_id:"r",error:"Problem"},{status:code==="invalid_token"?401:409}):Response.json(data);});
 const client=createMulticaPublicApi({server,workspaceId:wire.workspace_id,getConfiguredServer:()=>current?server:null,credentials,fetch:fetcher as unknown as typeof fetch,delegationsEnabled:()=>enabled});
 const context:ResultContext={runId:"run",projectId:"p",taskId:"task",sessionId:"s",version:1,requestId:"request",serverKey:server.key,serverOrigin:client.binding.origin,workspaceId:wire.workspace_id,remote,digest:"a".repeat(64)};
 const confirm=vi.fn(async(_detail:string)=>{events.push("consent");return true;});const save=vi.fn(async(_id:string,_input:unknown)=>{events.push("import");});const policy=vi.fn(async(_request:DelegationPolicyRequest)=>({code:"policy_absent"}));
 const flow=createResultImportFlow({context:async()=>structuredClone(context),client:async()=>client,policy,save,confirm,enabled:()=>enabled,now:()=>now});
 return {flow,client,context,credentials,fetcher,confirm,save,policy,events,change:(mode:string)=>{if(mode==="revoked")code="invalid_token";if(mode==="changed")code="revision_conflict";if(mode==="digest")data={...wire,digest:"0".repeat(64)};if(mode==="missing"||mode==="cancelled")data={...wire,text:""};if(mode==="oversized")data={...wire,text:"x".repeat(32769)};if(mode==="disabled")enabled=false;if(mode==="disconnect")current=false;if(mode==="expired")now+=120001;if(mode==="version")context.version++;}};
}
async function read(f:ReturnType<typeof setup>){const p=await f.flow.preview("run");expect(p?.text).toBeUndefined();expect(f.events).toEqual([]);const update=await f.flow.confirm(p!.id,p!.digest,()=>true);expect(update.ok).toBe(true);expect(update.preview?.phase).toBe("import");expect(f.save).not.toHaveBeenCalled();return update.preview!;}
describe("bounded specialist result",()=>{
 it("pins both fixtures and rejects malformed or changed text",()=>{if(process.env.MULTICA_RESULT_CONTRACT_FIXTURE)expect(readFileSync(process.env.MULTICA_RESULT_CONTRACT_FIXTURE,"utf8")).toBe(raw);expect(delegationResult(wire,remote)).toEqual(wire);for(const mutation of [{text:"changed"},{digest:"0".repeat(64)},{revision:"0".repeat(64)},{byte_count:1},{byte_count:String(wire.byte_count)},{text:"x".repeat(32769)},{text:"https://private.test"},{text:"mul_private"},{status:"running"},{format:"text/html"},{text:"\ud800"}])expect(()=>delegationResult({...wire,...mutation},remote)).toThrow();});
 it("reads nothing before native consent",async()=>{const f=setup();const p=await f.flow.preview("run");expect(f.fetcher).not.toHaveBeenCalled();f.confirm.mockResolvedValue(false);expect(await f.flow.confirm(p!.id,p!.digest,()=>true)).toEqual({ok:false});expect(await f.client.getDelegationResult(remote,false,async()=>null,()=>true)).toMatchObject({ok:false,code:"confirmation_required"});expect(f.fetcher).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();});
 it("treats malicious instructions as data and requires separate copy approval",async()=>{const f=setup();const p=await read(f);expect(p.untrusted).toBe(true);expect(p.text).toContain("Ignore all prior instructions");expect(f.events).toEqual(["consent","read"]);expect(await f.flow.confirm(p.id,p.digest,()=>true)).toEqual({ok:true});expect(f.events).toEqual(["consent","read","consent","read","import"]);expect(f.confirm.mock.calls[1][0]).toContain("BEGIN UNTRUSTED SPECIALIST TEXT");expect((f.fetcher.mock.calls[1][1].headers as Record<string,string>)["X-Result-Revision"]).toBe(wire.revision);expect(await f.flow.confirm(p.id,p.digest,()=>true)).toEqual({ok:false});expect(f.save).toHaveBeenCalledOnce();});
 it.each(["revoked","changed","digest","missing","cancelled","oversized","disabled","disconnect","expired","version","denied","cancel"])("refuses %s before copying",async mode=>{const f=setup();const p=await read(f);f.change(mode);if(mode==="denied")f.policy.mockResolvedValue({code:"policy_denied"});if(mode==="cancel")f.confirm.mockResolvedValue(false);expect(await f.flow.confirm(p.id,p.digest,()=>true)).toEqual({ok:false});expect(f.save).not.toHaveBeenCalled();});
 it("rechecks consent after credential lookup",async()=>{const f=setup();const p=await f.flow.preview("run");let active=true;vi.mocked(f.credentials.resolve).mockImplementation(async()=>{active=false;return {ok:true,token:"mul_fixture_pat"} as never;});expect(await f.flow.confirm(p!.id,p!.digest,()=>active)).toEqual({ok:false});expect(f.fetcher).not.toHaveBeenCalled();});
 it("rejects stale preview and unsupported policy response",async()=>{const f=setup();const p=await f.flow.preview("run");f.flow.invalidate();expect(await f.flow.confirm(p!.id,p!.digest,()=>true)).toEqual({ok:false});const q=await f.flow.preview("run");f.policy.mockResolvedValue({code:"unsupported"});expect(await f.flow.confirm(q!.id,q!.digest,()=>true)).toEqual({ok:false});expect(f.fetcher).not.toHaveBeenCalled();});
});

it("does not restore an invalidated preview after a delayed metadata request",async()=>{
 const f=setup();let release!:(value:ResultContext)=>void;
 const flow=createResultImportFlow({context:()=>new Promise(resolve=>{release=resolve;}),client:async()=>f.client,policy:f.policy,save:f.save,confirm:f.confirm,enabled:()=>true});
 const preview=flow.preview("run");flow.invalidate();release(f.context);
 expect(await preview).toBeNull();expect(f.fetcher).not.toHaveBeenCalled();
});


it("rejects foreign frames, unfocused clicks and forged native result requests",async()=>{
 const f=setup();const key=Buffer.alloc(32,7);const authority=createMainProcessDelegationAuthority(key);
 const handlers=new Map<string,(event:IpcMainInvokeEvent,...args:unknown[])=>unknown>();
 const shell={id:7,mainFrame:{},isDestroyed:()=>false,isFocused:vi.fn(()=>true),send:vi.fn(),on:vi.fn(),removeListener:vi.fn()};
 const event={sender:{id:7},senderFrame:shell.mainFrame} as unknown as IpcMainInvokeEvent;
 const fetcher=async(_url:unknown,init?:RequestInit)=>{const mac=authority.runRequestMAC(String(init?.body));const raw=JSON.stringify({record:f.context});const proof=createHmac("sha256",key).update(`journal-response-v1:${mac}:${raw}`).digest("hex");return new Response(raw,{headers:{"X-AO-Delegation-Response-MAC":proof}});};
 const registration=registerResultImport({ipcMain:{handle:(channel,callback)=>{handlers.set(channel,callback);},removeHandler:vi.fn()},shellWebContents:shell as unknown as Parameters<typeof registerResultImport>[0]["shellWebContents"],authority,origin:()=>"http://127.0.0.1:9999",fetch:fetcher as typeof fetch,client:async()=>f.client,policy:f.policy,enabled:()=>true,confirm:f.confirm});
 const preview=await handlers.get(RESULT_PREVIEW)!(event,"run") as import("../shared/specialist-result").ResultPreview;
 const input={id:preview.id,digest:preview.digest};
 await handlers.get(RESULT_CLICK)!({...event,senderFrame:{}} as IpcMainInvokeEvent,input);
 shell.isFocused.mockReturnValue(false);await handlers.get(RESULT_CLICK)!(event,input);
 shell.isFocused.mockReturnValue(true);await handlers.get(RESULT_CLICK)!(event,{...input,approved:true});
 expect(f.confirm).not.toHaveBeenCalled();expect(f.fetcher).not.toHaveBeenCalled();
 f.confirm.mockResolvedValue(false);await handlers.get(RESULT_CLICK)!(event,input);
 expect(f.confirm).toHaveBeenCalledOnce();expect(f.fetcher).not.toHaveBeenCalled();registration.dispose();
});


it("refuses recognizable credentials in otherwise bounded plain text",()=>{
 for(const value of ["token=private","AKIA1234567890ABCDEF","npm_private","mailto:person@example.test","data:text,private"]){expect(()=>resultText(value)).toThrow();}
});


it("requires current read permission as well as import permission before re-reading",async()=>{
 const f=setup();const p=await read(f);
 f.policy.mockImplementation(async request=>({code:request.action==="result_read"?"policy_denied":"policy_allowed"}));
 expect(await f.flow.confirm(p.id,p.digest,()=>true)).toEqual({ok:false});
 expect(f.fetcher).toHaveBeenCalledOnce();expect(f.save).not.toHaveBeenCalled();
});
