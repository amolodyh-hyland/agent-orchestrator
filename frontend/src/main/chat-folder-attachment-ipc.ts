import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Dialog, IpcMain } from "electron";
import {
	CHAT_FOLDER_ATTACHMENT_CHANNEL,
	CHAT_ATTACHMENT_PATH_CHANNEL,
	type ChatAttachmentPathInput,
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

export function registerChatAttachmentPathIpc(deps: {
	ipcMain: Pick<IpcMain, "handle">;
	resolveWorkspace: (sessionId: string) => Promise<string>;
	showItemInFolder: (filePath: string) => void;
	platform?: NodeJS.Platform;
}): void {
	const paths = (deps.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
	deps.ipcMain.handle(CHAT_ATTACHMENT_PATH_CHANNEL, async (_event, input: ChatAttachmentPathInput): Promise<string> => {
		if (!input || typeof input.path !== "string" || !input.path || /[\0\r\n]/.test(input.path) ||
			(input.action !== "resolve" && input.action !== "reveal")) throw new Error("Invalid attachment path.");
		let target = input.path;
		if (!paths.isAbsolute(target)) {
			if (!input.sessionId || typeof input.sessionId !== "string" || /^[A-Za-z]:|^[\\/]/.test(target)) throw new Error("A local session is required.");
			const workspace = await deps.resolveWorkspace(input.sessionId);
			if (!paths.isAbsolute(workspace)) throw new Error("Session workspace is not available.");
			target = paths.resolve(workspace, target);
			const relative = paths.relative(workspace, target);
			if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) throw new Error("Attachment is outside the workspace.");
		}
		if (input.action === "reveal") deps.showItemInFolder(target);
		return target;
	});
}

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

	// Message text is re-parsed line by line, so a trailing blank would not survive a re-send.
	if (/\s$/.test(canonicalPath)) return { error: "trailing_whitespace" };

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
