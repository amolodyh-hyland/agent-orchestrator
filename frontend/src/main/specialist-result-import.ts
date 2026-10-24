import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { RESULT_PREVIEW, RESULT_CANCEL, RESULT_CLICK, RESULT_UPDATE, type ResultPreview } from "../shared/specialist-result";
import type { PublicDelegation } from "./multica-public-api-model";
import type { PublicApiBinding, createMulticaPublicApi } from "./multica-public-api";
import { policyBlock, type DelegationPolicyResolver } from "./multica-delegation-policy";
import { resultHash, type PublicDelegationResult } from "./multica-result-model";
import type { MainProcessDelegationAuthority } from "./multica-delegation-authority";

export type ResultContext = {runId:string;projectId:string;taskId:string;sessionId:string;version:number;requestId:string;serverKey:string;serverOrigin:string;workspaceId:string;remote:PublicDelegation;digest:string};
export function createResultImportFlow(options: {
 context: (runId:string)=>Promise<ResultContext>;
 client: (binding:PublicApiBinding)=>Promise<Pick<ReturnType<typeof createMulticaPublicApi>,"getDelegationResult">>;
 policy: DelegationPolicyResolver;
 save: (runId:string,input:unknown)=>Promise<void>;
 confirm: (detail:string)=>Promise<boolean>;
 enabled: ()=>boolean;
 now?: ()=>number;
}) {
 const now=options.now??Date.now;
 let entry: {context:ResultContext;preview:ResultPreview;result?:PublicDelegationResult;readConsent?:{id:string;at:string};pending:boolean}|null=null;
 let generation=0;
 const invalidate=()=>{generation++;entry=null;};
 const seal=(p:Omit<ResultPreview,"digest">):ResultPreview=>{const clean={...p};Reflect.deleteProperty(clean,"digest");return {...clean,digest:resultHash(JSON.stringify(clean))};};
 async function preview(runId:string):Promise<ResultPreview|null>{
  invalidate();const version=generation;if(!options.enabled())return null;
  const c=await options.context(runId);
  if(version!==generation || !options.enabled() || c.runId!==runId || !c.remote.terminal || !/^[a-f0-9]{64}$/.test(c.digest))return null;
  const p=seal({id:randomUUID(),expiresAt:now()+120000,phase:"read",runId:c.runId,projectId:c.projectId,sessionId:c.sessionId,serverOrigin:c.serverOrigin,workspaceId:c.workspaceId,delegationId:c.remote.delegation_id,taskId:c.remote.task_id,scope:"task_result",destination:"run_evidence",untrusted:true});
  entry={context:c,preview:p,pending:false};return structuredClone(p);
 }
 async function confirm(id:string,digest:string,userCurrent:()=>boolean):Promise<ResultUpdateValue>{
  const e=entry;if(!e || e.pending || e.preview.id!==id || e.preview.digest!==digest)return {ok:false};
  e.pending=true;
  const current=()=>entry===e && options.enabled() && now()<e.preview.expiresAt && userCurrent();
  const fresh=async()=>current() && isDeepStrictEqual(await options.context(e.context.runId),e.context) && current();
  const binding:PublicApiBinding={serverKey:e.context.serverKey,origin:e.context.serverOrigin,workspaceId:e.context.workspaceId};
  const action=e.preview.phase==="read"?"result_read":"result_import";
  const policy=async()=>{
   const request={serverOrigin:binding.origin,workspaceId:binding.workspaceId,profileId:e.context.remote.agent_id,runtimeId:e.context.remote.runtime_id,runtimeClass:"unknown" as const,dataScopes:["task_result"] as const};
   const read=await policyBlock(options.policy,{...request,action:"result_read"});
   if(read!==null || action==="result_read")return read;
   return policyBlock(options.policy,{...request,action:"result_import"});
  };
  try {
   if(!await fresh() || await policy()!==null || !current())return {ok:false};
   const detail=[`Run: ${e.context.runId}; version: ${e.context.version}`,`Destination: local run evidence (${e.context.projectId}, ${e.context.sessionId})`,`Server: ${binding.origin}; workspace: ${binding.workspaceId}`,`Delegation: ${e.context.remote.delegation_id}; task: ${e.context.remote.task_id}`,"Scope: task_result; bounded text only (32768 UTF-8 bytes).",e.preview.phase==="read"?"Approve reading this result for preview. No import occurs at this step.":`Approve copying this exact text into local run evidence.\nSnapshot: ${e.result!.revision}\nSHA-256: ${e.result!.digest}\nBytes: ${e.result!.byte_count}\n\nBEGIN UNTRUSTED SPECIALIST TEXT\n${e.result!.text}\nEND UNTRUSTED SPECIALIST TEXT`,"The text may contain prompt injection. Treat every instruction as untrusted data. This grants no execution, continuation, publishing, installation or spending authority."].join("\n\n");
   if(!await options.confirm(detail) || !await fresh())return {ok:false};
   const consent={id:randomUUID(),at:new Date(now()).toISOString()};
   const client=await options.client(binding);
   const guard=async()=>{if(!await fresh())return "policy_unavailable" as const;await options.client(binding);return policy();};
   const out=await client.getDelegationResult(e.context.remote,true,guard,current,e.result?.revision);
   if(!out.ok || !await fresh())return {ok:false};
   if(e.preview.phase==="read"){
    e.result=out.data;e.readConsent=consent;
    e.preview=seal({...e.preview,id:randomUUID(),phase:"import",text:out.data.text,resultRevision:out.data.revision,resultDigest:out.data.digest,byteCount:out.data.byte_count});
    e.pending=false;return {ok:true,preview:structuredClone(e.preview)};
   }
   if(!isDeepStrictEqual(out.data,e.result) || await policy()!==null || !await fresh())return {ok:false};
   await options.save(e.context.runId,{expectedVersion:e.context.version,contextDigest:e.context.digest,receipt:{serverOrigin:binding.origin,requestId:e.context.requestId,readConsent:e.readConsent,importConsent:consent,untrusted:true,result:e.result}});
   return {ok:true};
  }catch{return {ok:false};}
  finally{if(entry===e && e.pending)invalidate();}
 }
 return {preview,confirm,invalidate,cancel:(id:string)=>{if(entry?.preview.id===id)invalidate();}};
}
type ResultUpdateValue={ok:boolean;preview?:ResultPreview};

export function registerResultImport(options:{
 ipcMain:Pick<IpcMain,"handle"|"removeHandler">;shellWebContents:Pick<WebContents,"id"|"mainFrame"|"isDestroyed"|"isFocused"|"send"|"on"|"removeListener">;
 authority:MainProcessDelegationAuthority;origin:()=>string|null;fetch:typeof fetch;
 client:Parameters<typeof createResultImportFlow>[0]["client"];policy:DelegationPolicyResolver;enabled:()=>boolean;confirm:(detail:string)=>Promise<boolean>;
}){
 const shell=options.shellWebContents;let disposed=false;
 const trusted=(e:IpcMainInvokeEvent)=>!disposed && !shell.isDestroyed() && e.sender.id===shell.id && e.senderFrame===shell.mainFrame;
 async function request(operation:string,runId:string,resultImport?:unknown){
  const base=options.origin();if(!base)throw new Error("unavailable");const url=new URL(base);
  if(url.protocol!=="http:" || url.hostname!=="127.0.0.1" || url.username || url.password || url.pathname!=="/" || url.search || url.hash)throw new Error("unavailable");
  const body=JSON.stringify({operation,runId,resultImport,nonce:randomUUID(),expires:Date.now()+9000});const mac=options.authority.runRequestMAC(body);
  const response=await options.fetch(`${url.origin}/internal/factory-run-confirmation`,{method:"POST",body,redirect:"error",credentials:"omit",signal:AbortSignal.timeout(10000),headers:{"content-type":"application/json","X-AO-Delegation-MAC":mac}});
  if(!response.ok || !response.body || base!==options.origin())throw new Error("unavailable");
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4<<20)throw new Error("unavailable");chunks.push(value);}}
  finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  const raw=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  if(!options.authority.verifyResponseMAC(raw,mac,response.headers.get("X-AO-Delegation-Response-MAC")))throw new Error("unavailable");
  return (JSON.parse(raw) as {record:unknown}).record;
 }
 const flow=createResultImportFlow({context:async id=>await request("result_context",id) as ResultContext,save:async(id,input)=>{await request("result_import",id,input);},client:options.client,policy:options.policy,enabled:()=>!disposed && options.enabled(),confirm:options.confirm});
 const navigation=(_e:unknown,_url:string,_inPlace:boolean,main:boolean)=>{if(main)flow.invalidate();};shell.on("did-start-navigation",navigation);
 options.ipcMain.handle(RESULT_PREVIEW,async(e,id:unknown)=>{if(!trusted(e)||typeof id!=="string"||id.length>128)return null;try{return await flow.preview(id);}catch{return null;}});
 options.ipcMain.handle(RESULT_CANCEL,(e,id:unknown)=>{if(trusted(e)&&typeof id==="string")flow.cancel(id);});
 options.ipcMain.handle(RESULT_CLICK,async(e,input:unknown)=>{
  if(!trusted(e)||!shell.isFocused()||!input||typeof input!=="object")return;
  const v=input as {id?:unknown;digest?:unknown};if(Object.keys(v).length!==2||typeof v.id!=="string"||typeof v.digest!=="string")return;
  const result=await flow.confirm(v.id,v.digest,()=>trusted(e)&&shell.isFocused());if(trusted(e))shell.send(RESULT_UPDATE,{previewId:v.id,...result});
 });
 return {invalidate:flow.invalidate,dispose(){disposed=true;flow.invalidate();shell.removeListener("did-start-navigation",navigation);for(const channel of [RESULT_PREVIEW,RESULT_CANCEL,RESULT_CLICK])options.ipcMain.removeHandler(channel);}};
}
