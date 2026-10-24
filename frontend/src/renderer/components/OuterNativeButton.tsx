import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import type { OuterNativeDraft, OuterResult } from "../../shared/outer-native";
import { useOuterNativeAction } from "../hooks/useOuter";
import { Button } from "./ui/button";

export function OuterNativeButton({
	draft,
	onResult,
	disabled,
	...props
}: Omit<ComponentProps<typeof Button>, "onClick"> & {
	draft?: OuterNativeDraft;
	onResult?: (result: OuterResult) => void;
}) {
	const { t } = useTranslation();
	const action = useOuterNativeAction(disabled ? undefined : draft, onResult);
	return (
		<>
			<Button
				{...props}
				{...action.attributes}
				type="button"
				disabled={disabled || !action.ready}
			/>
			{action.held || (action.result && !action.result.ok) ? (
				<span role="alert" className="text-xs text-destructive">
					{t("outer.actionHeld")}
				</span>
			) : null}
		</>
	);
}

export type NativeReplyTarget = { sessionId: string; generation: string };
export function NativeInputActionButton({
	target,
	requestId,
	action,
	content,
	...props
}: Omit<ComponentProps<typeof OuterNativeButton>, "draft" | "content"> & {
	target: NativeReplyTarget;
	requestId: string;
	action: "accept" | "decline" | "cancel";
	content?: Record<string, unknown>;
}) {
	return (
		<OuterNativeButton
			{...props}
			draft={{
				operation: "control",
				control: {
					action: "chat.input",
					targetId: target.sessionId,
					pendingId: requestId,
					generation: target.generation,
					body: { action, content },
				},
			}}
		/>
	);
}
