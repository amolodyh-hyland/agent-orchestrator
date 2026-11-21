import { createContext } from "react";

export type SessionPanePreviewTarget = {
	projectId: string;
	sessionId: string;
	hostId?: string;
	sourceKind?: "cloud";
	path?: string;
};

export const SessionPanePreviewContext = createContext<((target: SessionPanePreviewTarget) => void) | undefined>(undefined);
