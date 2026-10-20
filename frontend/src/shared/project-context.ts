export const CHOOSE_PROJECT_CONTEXT_CHANNEL = "projectContext:chooseLink";

export type ProjectContextLinkRequest = { kind: "file" | "folder"; title: string };
export type ProjectContextLinkSelection = { localPath: string; name: string; mediaType: string };
