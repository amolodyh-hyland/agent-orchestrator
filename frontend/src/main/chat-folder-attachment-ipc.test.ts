import { describe, expect, it, vi } from "vitest";
import { CHAT_FOLDER_ATTACHMENT_CHANNEL, CHAT_ATTACHMENT_PATH_CHANNEL } from "../shared/chat-folder-attachment";
import {
	registerChatFolderAttachmentIpc,
	registerChatAttachmentPathIpc,
	ChatAttachmentPathGrants,
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

describe("validateChatFolderAttachment canonical target", () => {
	const linkedFileSystem = (overrides: Partial<ChatFolderAttachmentFileSystem>) => fileSystem({
		realpath: vi.fn(async () => "/Users/me/real"),
		lstat: vi.fn(async (folderPath: string) => folderPath === "/Users/me/picked" ? directoryStats() : directoryStats(false)),
		...overrides,
	});

	it("revalidates the canonical target instead of trusting the picked path", async () => {
		await expect(validateChatFolderAttachment("/Users/me/picked", linkedFileSystem({}))).resolves.toEqual({ error: "not_directory" });
		await expect(validateChatFolderAttachment("/Users/me/picked", linkedFileSystem({
			lstat: vi.fn(async (folderPath: string) => folderPath === "/Users/me/picked" ? directoryStats() : directoryStats(false, true)),
		}))).resolves.toEqual({ error: "symbolic_link" });
	});

	it("checks readability on the canonical target", async () => {
		const access = vi.fn(async (folderPath: string) => {
			if (folderPath === "/Users/me/real") throw Object.assign(new Error("denied"), { code: "EACCES" });
		});
		await expect(validateChatFolderAttachment("/Users/me/picked", fileSystem({
			realpath: vi.fn(async () => "/Users/me/real"),
			access,
		}))).resolves.toEqual({ error: "not_readable" });
		expect(access).toHaveBeenCalledWith("/Users/me/real", expect.any(Number));
	});

	it("rejects folders whose path ends in whitespace", async () => {
		await expect(validateChatFolderAttachment("/Users/me/Project ", fileSystem())).resolves.toEqual({ error: "trailing_whitespace" });
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

describe("attachment path IPC", () => {
	const event = { sender: { id: 1 } };
	function setup(overrides: Partial<Parameters<typeof registerChatAttachmentPathIpc>[0]> = {}) {
		const { registered, ipcMain } = handlers();
		const reveal = vi.fn();
		const resolveWorkspace = vi.fn(async () => "/work");
		registerChatAttachmentPathIpc({ ipcMain, resolveWorkspace, showItemInFolder: reveal,
			isTrustedSender: (id) => id === 1, fileSystem: fileSystem(), platform: "darwin", ...overrides });
		return { registered, ipcMain, reveal, resolveWorkspace,
			invoke: (target: string, sessionId: unknown = "ao-1", action = "reveal", sender = event) =>
				registered.get(CHAT_ATTACHMENT_PATH_CHANNEL)!(sender, { path: target, sessionId, action }) };
	}

	it.each([
		["darwin", "/work", "/work/.ao/attachments/attachment-a.txt"],
		["win32", "C:\\work", "C:\\work\\.ao\\attachments\\attachment-a.txt"],
	] as const)("resolves local staged paths on %s for copying without revealing", async (platform, workspace, expected) => {
		const resolveWorkspace = vi.fn(async () => workspace);
		const s = setup({ platform, resolveWorkspace });
		await expect(s.invoke(".ao/attachments/attachment-a.txt", "ao-1", "resolve")).resolves.toBe(expected);
		expect(resolveWorkspace).toHaveBeenCalledWith("ao-1");
		expect(s.reveal).not.toHaveBeenCalled();
	});

	it.each([
		["darwin", "/work", "/work/folder/", "/work/folder"],
		["win32", "C:\\work", "C:\\work\\folder\\", "C:\\work\\folder"],
		["win32", "\\\\server\\share", "\\\\server\\share\\folder\\", "\\\\server\\share\\folder"],
	] as const)("reveals authorized absolute workspace paths on %s", async (platform, workspace, target, canonical) => {
		const s = setup({ platform, resolveWorkspace: async () => workspace });
		await expect(s.invoke(target)).resolves.toBe(canonical);
		expect(s.reveal).toHaveBeenCalledWith(canonical);
	});

	it.each(["../secret", "", "bad\npath", "C:relative", "/private/secret"])("rejects invalid or ungranted paths: %s", async (target) => {
		const s = setup();
		await expect(s.invoke(target)).rejects.toThrow();
		expect(s.reveal).not.toHaveBeenCalled();
	});

	it.each([undefined, null, "", 42, "remote:host:ao-1", "cloud:ao-1"])("rejects absolute paths without valid local context: %s", async (sessionId) => {
		const s = setup();
		// Pass undefined explicitly rather than using invoke's default session.
		await expect(s.registered.get(CHAT_ATTACHMENT_PATH_CHANNEL)!(event, { path: "/work/file", sessionId, action: "reveal" })).rejects.toThrow();
		expect(s.resolveWorkspace).not.toHaveBeenCalled();
		expect(s.reveal).not.toHaveBeenCalled();
	});

	it.each(["missing-session", "cloud-session", "remote-session"])("requires the local daemon to resolve even absolute paths: %s", async (sessionId) => {
		const s = setup({ resolveWorkspace: vi.fn(async () => { throw new Error("Unknown local session"); }) });
		await expect(s.invoke("/work/file", sessionId)).rejects.toThrow("Unknown local session");
		expect(s.reveal).not.toHaveBeenCalled();
	});

	it("rejects unavailable workspaces and untrusted senders", async () => {
		const s = setup({ resolveWorkspace: async () => "relative/work" });
		await expect(s.invoke("/work/file")).rejects.toThrow("workspace");
		await expect(s.invoke("/work/file", "ao-1", "reveal", { sender: { id: 2 } })).rejects.toThrow("Untrusted");
		expect(s.reveal).not.toHaveBeenCalled();
	});

	it.each([
		["darwin", "/work", "link/secret", "/work/link/secret", "/private/secret"],
		["darwin", "/work", "/work/link/secret", "/work/link/secret", "/private/secret"],
		["win32", "C:\\work", "link/secret", "C:\\work\\link\\secret", "D:\\secret"],
		["win32", "C:\\work", "C:\\work\\link\\secret", "C:\\work\\link\\secret", "D:\\secret"],
	] as const)("rejects canonical symlink escapes on %s: %s %s", async (platform, workspace, target, linked, outside) => {
		const s = setup({ platform, resolveWorkspace: async () => workspace,
			fileSystem: fileSystem({ realpath: vi.fn(async (p) => p === linked ? outside : p) }) });
		await expect(s.invoke(target)).rejects.toThrow("outside the workspace");
		expect(s.reveal).not.toHaveBeenCalled();
	});

	it("uses the canonical workspace and target before revealing", async () => {
		const s = setup({ fileSystem: fileSystem({ realpath: vi.fn(async (p) => p.replace("/work", "/canonical/work")) }) });
		await expect(s.invoke("folder/file")).resolves.toBe("/canonical/work/folder/file");
		expect(s.reveal).toHaveBeenCalledWith("/canonical/work/folder/file");
	});

	it("grants only validated native-selected folders to the selecting shell", async () => {
		const pathGrants = new ChatAttachmentPathGrants();
		const s = setup({ pathGrants, isTrustedSender: () => true });
		registerChatFolderAttachmentIpc({ ipcMain: s.ipcMain as never, pathGrants, fileSystem: fileSystem(),
			dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/outside/Chosen"] })) } as never });
		await s.registered.get(CHAT_FOLDER_ATTACHMENT_CHANNEL)!(event);
		await expect(s.invoke("/outside/Chosen")).resolves.toBe("/outside/Chosen");
		expect(s.reveal).toHaveBeenCalledWith("/outside/Chosen");
		s.reveal.mockClear();
		await expect(s.invoke("/outside/Chosen", "ao-1", "reveal", { sender: { id: 2 } })).rejects.toThrow("not been granted");
		await expect(s.invoke("/outside/Chosen/child")).rejects.toThrow("not been granted");
		await expect(s.invoke("/outside/Other")).rejects.toThrow("not been granted");
		expect(s.reveal).not.toHaveBeenCalled();
	});

	it("requires local context for native grants and rejects escapes even to a granted folder", async () => {
		const pathGrants = new ChatAttachmentPathGrants();
		pathGrants.grant(event.sender, "/outside/Chosen");
		const s = setup({ pathGrants, fileSystem: fileSystem({ realpath: vi.fn(async (p) =>
			p === "/work/link" ? "/outside/Chosen" : p) }) });
		await expect(s.registered.get(CHAT_ATTACHMENT_PATH_CHANNEL)!(event, { path: "/outside/Chosen", action: "reveal" })).rejects.toThrow("local session");
		await expect(s.invoke("/outside/Chosen", "cloud:ao-1")).rejects.toThrow("local session");
		await expect(s.invoke("link")).rejects.toThrow("outside the workspace");
		await expect(s.invoke("/outside/Other", "ao-1", "resolve")).rejects.toThrow("not been granted");
		expect(s.reveal).not.toHaveBeenCalled();
	});

	it("does not grant cancelled, failed or untrusted native selections", async () => {
		const pathGrants = new ChatAttachmentPathGrants();
		const s = setup({ pathGrants });
		registerChatFolderAttachmentIpc({ ipcMain: s.ipcMain as never, pathGrants, fileSystem: fileSystem(),
			isTrustedSender: (id) => id === 1,
			dialog: { showOpenDialog: vi.fn()
				.mockResolvedValueOnce({ canceled: true, filePaths: ["/outside/Chosen"] })
				.mockResolvedValueOnce({ canceled: false, filePaths: ["relative"] }) } as never });
		const pick = s.registered.get(CHAT_FOLDER_ATTACHMENT_CHANNEL)!;
		await expect(pick(event)).resolves.toBeNull();
		await expect(pick(event)).resolves.toEqual({ error: "invalid_path" });
		await expect(pick({ sender: { id: 2 } })).rejects.toThrow("Untrusted");
		await expect(s.invoke("/outside/Chosen")).rejects.toThrow("not been granted");
		expect(s.reveal).not.toHaveBeenCalled();
	});

	it("rejects an external grant after its target is replaced by a symlink or file", async () => {
		const pathGrants = new ChatAttachmentPathGrants();
		pathGrants.grant(event.sender, "/outside/Chosen");
		const fs = fileSystem();
		const s = setup({ pathGrants, fileSystem: fs });
		vi.mocked(fs.realpath).mockImplementation(async (p) => p === "/outside/Chosen" ? "/outside/Other" : p);
		await expect(s.invoke("/outside/Chosen")).rejects.toThrow("not been granted");
		vi.mocked(fs.realpath).mockImplementation(async (p) => p);
		vi.mocked(fs.lstat).mockResolvedValue(directoryStats(false));
		await expect(s.invoke("/outside/Chosen")).rejects.toThrow("not been granted");
		expect(s.reveal).not.toHaveBeenCalled();
	});
});
