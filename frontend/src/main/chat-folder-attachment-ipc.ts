import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Dialog, IpcMain } from "electron";
import {
	CHAT_FOLDER_ATTACHMENT_CHANNEL,
	type ChatFolderAttachmentError,
	type ChatFolderAttachmentPickerResult,
} from "../shared/chat-folder-attachment";

type FolderStats = Pick<Awaited<ReturnType<typeof lstat>>, "isDirectory" | "isSymbolicLink">;

export type ChatFolderAttachmentFileSystem = {
	lstat: (filePath: string) => Promise<FolderStats>;
	realpath: (filePath: string) => Promise<string>;
	access: (filePath: string, mode: number) => Promise<void>;
};

export type ChatFolderAttachmentIpcDeps = {
	ipcMain: Pick<IpcMain, "handle">;
	dialog: Pick<Dialog, "showOpenDialog">;
	fileSystem?: ChatFolderAttachmentFileSystem;
	machineName?: () => string;
};

const defaultFileSystem: ChatFolderAttachmentFileSystem = { lstat, realpath, access };

function fileSystemError(cause: unknown): ChatFolderAttachmentError {
	const code = cause && typeof cause === "object" && "code" in cause
		? String((cause as { code?: unknown }).code)
		: "";
	if (code === "ENOENT" || code === "ENOTDIR") return "not_found";
	if (code === "EACCES" || code === "EPERM") return "not_readable";
	if (code === "ELOOP") return "symbolic_link";
	return "invalid_path";
}

export async function validateChatFolderAttachment(
	folderPath: string,
	fileSystem: ChatFolderAttachmentFileSystem = defaultFileSystem,
	machineName: () => string = os.hostname,
): Promise<ChatFolderAttachmentPickerResult> {
	if (!path.isAbsolute(folderPath) || folderPath.includes("\0")) return { error: "invalid_path" };

	let folderStats: FolderStats;
	try {
		folderStats = await fileSystem.lstat(folderPath);
	} catch (cause) {
		return { error: fileSystemError(cause) };
	}
	if (folderStats.isSymbolicLink()) return { error: "symbolic_link" };
	if (!folderStats.isDirectory()) return { error: "not_directory" };

	let canonicalPath: string;
	try {
		canonicalPath = await fileSystem.realpath(folderPath);
		const canonicalStats = await fileSystem.lstat(canonicalPath);
		if (canonicalStats.isSymbolicLink()) return { error: "symbolic_link" };
		if (!canonicalStats.isDirectory()) return { error: "not_directory" };
		await fileSystem.access(canonicalPath, constants.R_OK | constants.X_OK);
	} catch (cause) {
		return { error: fileSystemError(cause) };
	}

	return {
		path: canonicalPath,
		name: path.basename(canonicalPath) || canonicalPath,
		machineName: machineName(),
	};
}

export function registerChatFolderAttachmentIpc(deps: ChatFolderAttachmentIpcDeps): void {
	const fileSystem = deps.fileSystem ?? defaultFileSystem;
	const machineName = deps.machineName ?? os.hostname;

	deps.ipcMain.handle(CHAT_FOLDER_ATTACHMENT_CHANNEL, async (): Promise<ChatFolderAttachmentPickerResult> => {
		const result = await deps.dialog.showOpenDialog({ properties: ["openDirectory"] });
		if (result.canceled || !result.filePaths[0]) return null;
		return validateChatFolderAttachment(result.filePaths[0], fileSystem, machineName);
	});
}
