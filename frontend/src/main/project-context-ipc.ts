import path from "node:path";
import type { Dialog, IpcMain } from "electron";
import { CHOOSE_PROJECT_CONTEXT_CHANNEL, type ProjectContextLinkRequest, type ProjectContextLinkSelection } from "../shared/project-context";

export function registerProjectContextIpc({ ipcMain, dialog, isTrustedSender }: {
	ipcMain: Pick<IpcMain, "handle">;
	dialog: Pick<Dialog, "showOpenDialog">;
	isTrustedSender: (senderId: number) => boolean;
}) {
	ipcMain.handle(CHOOSE_PROJECT_CONTEXT_CHANNEL, async (event, input: ProjectContextLinkRequest): Promise<ProjectContextLinkSelection | null> => {
		if (!isTrustedSender(event.sender.id)) throw new Error("Untrusted project context request");
		if (!input || !["file", "folder"].includes(input.kind) || typeof input.title !== "string" || input.title.length > 200) throw new Error("Invalid project context selection");
		const result = await dialog.showOpenDialog({ title: input.title, properties: [input.kind === "folder" ? "openDirectory" : "openFile"] });
		const localPath = result.filePaths[0];
		if (result.canceled || !localPath) return null;
		const mediaTypes: Record<string, string> = { ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".json": "application/json", ".yaml": "application/yaml", ".yml": "application/yaml" };
		return { localPath, name: path.basename(localPath), mediaType: input.kind === "folder" ? "inode/directory" : mediaTypes[path.extname(localPath).toLowerCase()] ?? "application/octet-stream" };
	});
}
