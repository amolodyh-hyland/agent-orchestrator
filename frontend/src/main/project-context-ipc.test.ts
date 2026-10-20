import { describe, expect, it, vi } from "vitest";
import { registerProjectContextIpc } from "./project-context-ipc";
import { CHOOSE_PROJECT_CONTEXT_CHANNEL } from "../shared/project-context";
function setup(trusted = true) {
	const handle = vi.fn();
	const showOpenDialog = vi.fn().mockResolvedValue({ canceled: false, filePaths: ["/private/notes.md"] });
	registerProjectContextIpc({ ipcMain: { handle }, dialog: { showOpenDialog }, isTrustedSender: () => trusted });
	expect(handle.mock.calls[0][0]).toBe(CHOOSE_PROJECT_CONTEXT_CHANNEL);
	return { choose: handle.mock.calls[0][1], showOpenDialog };
}
describe("Project context link picker IPC", () => {
	it("returns a typed link through a native file dialog without reading or copying content", async () => {
		const { choose, showOpenDialog } = setup();
		await expect(choose({ sender: { id: 1 } }, { kind: "file", title: "Link a file" })).resolves.toEqual({ name: "notes.md", localPath: "/private/notes.md", mediaType: "text/markdown" });
		expect(showOpenDialog).toHaveBeenCalledExactlyOnceWith({ title: "Link a file", properties: ["openFile"] });
	});
	it("uses a native directory dialog without traversing the directory", async () => {
		const { choose, showOpenDialog } = setup();
		await expect(choose({ sender: { id: 1 } }, { kind: "folder", title: "Link a folder" })).resolves.toMatchObject({ mediaType: "inode/directory" });
		expect(showOpenDialog).toHaveBeenCalledWith({ title: "Link a folder", properties: ["openDirectory"] });
	});
	it("returns no link on cancellation", async () => {
		const { choose, showOpenDialog } = setup();
		showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
		await expect(choose({ sender: { id: 1 } }, { kind: "file", title: "Link" })).resolves.toBeNull();
	});
	it.each([false, true])("rejects untrusted senders and malformed requests (trusted=%s)", async (trusted) => {
		const { choose, showOpenDialog } = setup(trusted);
		await expect(choose({ sender: { id: 2 } }, { kind: "execute", title: "Link" })).rejects.toThrow();
		expect(showOpenDialog).not.toHaveBeenCalled();
	});
});
