import { describe, expect, it, vi } from "vitest";
import { CHAT_FOLDER_ATTACHMENT_CHANNEL } from "../shared/chat-folder-attachment";
import {
	registerChatFolderAttachmentIpc,
	validateChatFolderAttachment,
	type ChatFolderAttachmentFileSystem,
} from "./chat-folder-attachment-ipc";

function handlers() {
	const registered = new Map<string, (...args: unknown[]) => unknown>();
	const ipcMain = {
		handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => registered.set(channel, handler)),
	};
	return { registered, ipcMain };
}

function directoryStats(isDirectory = true, isSymbolicLink = false) {
	return { isDirectory: () => isDirectory, isSymbolicLink: () => isSymbolicLink };
}

function fileSystem(overrides: Partial<ChatFolderAttachmentFileSystem> = {}): ChatFolderAttachmentFileSystem {
	return {
		lstat: vi.fn(async () => directoryStats()),
		realpath: vi.fn(async (folderPath: string) => folderPath),
		access: vi.fn(async () => undefined),
		...overrides,
	};
}

describe("validateChatFolderAttachment", () => {
	it("returns the canonical absolute folder path and machine name when readable", async () => {
		const fs = fileSystem();
		await expect(validateChatFolderAttachment("/Users/me/Projects/ao", fs, () => "dev-mac")).resolves.toEqual({
			path: "/Users/me/Projects/ao",
			name: "ao",
			machineName: "dev-mac",
		});
		expect(fs.access).toHaveBeenCalledWith("/Users/me/Projects/ao", expect.any(Number));
	});

	it("rejects invalid paths, missing folders, files, symlinks, and unreadable folders", async () => {
		await expect(validateChatFolderAttachment("relative/path", fileSystem())).resolves.toEqual({ error: "invalid_path" });
		await expect(validateChatFolderAttachment("/missing", fileSystem({
			lstat: vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
		}))).resolves.toEqual({ error: "not_found" });
		await expect(validateChatFolderAttachment("/Users/me/file.txt", fileSystem({
			lstat: vi.fn(async () => directoryStats(false)),
		}))).resolves.toEqual({ error: "not_directory" });
		await expect(validateChatFolderAttachment("/Users/me/link", fileSystem({
			lstat: vi.fn(async () => directoryStats(false, true)),
		}))).resolves.toEqual({ error: "symbolic_link" });
		await expect(validateChatFolderAttachment("/Users/me/private", fileSystem({
			access: vi.fn(async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }),
		}))).resolves.toEqual({ error: "not_readable" });
		await expect(validateChatFolderAttachment("/Users/me/loop", fileSystem({
			realpath: vi.fn(async () => { throw Object.assign(new Error("loop"), { code: "ELOOP" }); }),
		}))).resolves.toEqual({ error: "symbolic_link" });
	});
});

describe("registerChatFolderAttachmentIpc", () => {
	it("opens one folder and returns a validated selection", async () => {
		const { registered, ipcMain } = handlers();
		const dialog = { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/Users/me/Project"] })) };
		registerChatFolderAttachmentIpc({
			ipcMain: ipcMain as never,
			dialog: dialog as never,
			fileSystem: fileSystem(),
			machineName: () => "dev-mac",
		});

		await expect(registered.get(CHAT_FOLDER_ATTACHMENT_CHANNEL)?.()).resolves.toEqual({
			path: "/Users/me/Project",
			name: "Project",
			machineName: "dev-mac",
		});
		expect(dialog.showOpenDialog).toHaveBeenCalledWith({ properties: ["openDirectory"] });
	});

	it("returns null when canceled and reports symlink validation errors", async () => {
		const { registered, ipcMain } = handlers();
		const dialog = { showOpenDialog: vi.fn()
			.mockResolvedValueOnce({ canceled: true, filePaths: [] })
			.mockResolvedValueOnce({ canceled: false, filePaths: ["/Users/me/link"] }) };
		registerChatFolderAttachmentIpc({
			ipcMain: ipcMain as never,
			dialog: dialog as never,
			fileSystem: fileSystem({ lstat: vi.fn(async () => directoryStats(false, true)) }),
		});
		const handler = registered.get(CHAT_FOLDER_ATTACHMENT_CHANNEL);

		await expect(handler?.()).resolves.toBeNull();
		await expect(handler?.()).resolves.toEqual({ error: "symbolic_link" });
		expect(dialog.showOpenDialog).toHaveBeenCalledWith({ properties: ["openDirectory"] });
	});
});
