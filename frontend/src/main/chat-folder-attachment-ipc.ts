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
	pathGrants?: ChatAttachmentPathGrants;
	isTrustedSender?: (id: number) => boolean;
};

const defaultFileSystem: ChatFolderAttachmentFileSystem = { lstat, realpath, access };

/** Native selections are main-owned and scoped to the shell that chose them. */
export class ChatAttachmentPathGrants {
	private readonly folders = new WeakMap<object, Set<string>>();

	grant(sender: object, canonicalPath: string): void {
		const paths = this.folders.get(sender) ?? new Set<string>();
		paths.add(canonicalPath);
		this.folders.set(sender, paths);
	}

	allows(sender: object, canonicalPath: string): boolean {
		return this.folders.get(sender)?.has(canonicalPath) ?? false;
	}
}

export function registerChatAttachmentPathIpc(deps: {
	ipcMain: Pick<IpcMain, "handle">;
	/** Resolve through the local daemon's session store, never renderer metadata. */
	resolveWorkspace: (sessionId: string) => Promise<string>;
	showItemInFolder: (filePath: string) => void;
	isTrustedSender: (id: number) => boolean;
	pathGrants?: ChatAttachmentPathGrants;
	fileSystem?: ChatFolderAttachmentFileSystem;
	platform?: NodeJS.Platform;
}): void {
	const paths = (deps.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
	const fs = deps.fileSystem ?? defaultFileSystem;
	const contains = (root: string, target: string): boolean => {
		const relative = paths.relative(root, target);
		return relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
	};
	deps.ipcMain.handle(CHAT_ATTACHMENT_PATH_CHANNEL, async (event, input: ChatAttachmentPathInput): Promise<string> => {
		if (!deps.isTrustedSender(event.sender.id)) throw new Error("Untrusted attachment sender.");
		if (!input || typeof input.path !== "string" || !input.path || /[\0\r\n]/.test(input.path) ||
			(input.action !== "resolve" && input.action !== "reveal")) throw new Error("Invalid attachment path.");
		// Even absolute/native-picked paths require a live local session. Remote/cloud
		// namespaced IDs are not local IDs; unprefixed IDs must exist in the local store.
		if (typeof input.sessionId !== "string" || !input.sessionId || /^(remote|cloud):/.test(input.sessionId)) {
			throw new Error("A local session is required.");
		}
		const workspace = await deps.resolveWorkspace(input.sessionId);
		if (!paths.isAbsolute(workspace)) throw new Error("Session workspace is not available.");
		const absolute = paths.isAbsolute(input.path);
		if (!absolute && /^[A-Za-z]:|^[\\/]/.test(input.path)) throw new Error("Invalid attachment path.");
		const target = paths.resolve(workspace, input.path);
		const canonicalWorkspace = await fs.realpath(workspace);
		const canonicalTarget = await fs.realpath(target);
		if (!paths.isAbsolute(canonicalWorkspace) || !paths.isAbsolute(canonicalTarget)) throw new Error("Invalid attachment path.");
		const workspaceTarget = contains(workspace, target);
		if (!absolute && !workspaceTarget) throw new Error("Attachment is outside the workspace.");
		if (!contains(canonicalWorkspace, canonicalTarget)) {
			// A workspace symlink must not turn a workspace attachment into
			// permission to reveal another tree, even one selected separately.
			if (workspaceTarget) throw new Error("Attachment is outside the workspace.");
			if (!deps.pathGrants?.allows(event.sender, canonicalTarget) || !(await fs.lstat(canonicalTarget)).isDirectory()) {
				throw new Error("Attachment folder has not been granted by the native picker.");
			}
		}
		if (input.action === "reveal") deps.showItemInFolder(canonicalTarget);
		return canonicalTarget;
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

	deps.ipcMain.handle(CHAT_FOLDER_ATTACHMENT_CHANNEL, async (event): Promise<ChatFolderAttachmentPickerResult> => {
		if (deps.isTrustedSender && !deps.isTrustedSender(event.sender.id)) throw new Error("Untrusted attachment sender.");
		const result = await deps.dialog.showOpenDialog({ properties: ["openDirectory"] });
		if (result.canceled || !result.filePaths[0]) return null;
		const selection = await validateChatFolderAttachment(result.filePaths[0], fileSystem, machineName);
		if (selection && "path" in selection) deps.pathGrants?.grant(event.sender, selection.path);
		return selection;
	});
}
