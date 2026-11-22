import { createContext, useContext, type ReactNode } from "react";

export const ChatFindEngagedContext = createContext(false);

export function ChatFindUserProjection({ projection, children }: { projection: ReactNode; children: ReactNode }) {
	const engaged = useContext(ChatFindEngagedContext);
	return <>
		<div data-chat-find-projection="formatted" hidden={engaged} inert={engaged || undefined} aria-hidden={engaged || undefined} data-chat-find-exclude={engaged ? "" : undefined} style={{ display: engaged ? "none" : "contents" }}>
			{children}
		</div>
		<div data-chat-find-projection="search" hidden={!engaged} inert={!engaged || undefined} aria-hidden={!engaged || undefined} data-chat-find-exclude={!engaged ? "" : undefined} style={{ display: engaged ? "contents" : "none" }}>
			{engaged ? projection : null}
		</div>
	</>;
}
