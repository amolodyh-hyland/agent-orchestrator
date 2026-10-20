import { LOCAL_HOST } from "./hosts";

export const sessionProjectContextQueryRoot = ["session-project-context"] as const;
export const sessionProjectContextQueryKey = (sessionId: string, hostId = LOCAL_HOST) => [...sessionProjectContextQueryRoot, hostId, sessionId] as const;
