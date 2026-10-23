import type { ConversationActivity } from "../../types/conversation";
import { OuterNativeButton, type NativeReplyTarget } from "../OuterNativeButton";

export function NativeApprovalCard({activity,target}:{activity:ConversationActivity;target:NativeReplyTarget}) {
	return <div role="group" className="space-y-2 p-3">
		<p className="whitespace-pre-wrap text-sm">{activity.detail?.reason ?? activity.summary}</p>
		<pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs">{activity.detail?.rawCommand ?? activity.detail?.command}</pre>
		<div className="flex flex-wrap justify-end gap-2">{activity.decisions?.map((d)=><OuterNativeButton key={d.id} size="sm" variant="outline" draft={activity.requestId ? {operation:"control",control:{action:"chat.approval",targetId:target.sessionId,pendingId:activity.requestId,generation:target.generation,body:{decisionId:d.id}}}:undefined}>{d.label}</OuterNativeButton>)}</div>
	</div>;
}
