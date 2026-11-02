import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../../stores/ui-store";
import { aoBridge } from "../../lib/bridge";
import { AttachmentPathChip } from "./AttachmentPathChip";

afterEach(() => vi.restoreAllMocks());

const path = "/Users/me/Project Files/";

describe("attachment path chip", () => {
	it.each([
		[path, "Project Files"],
		["C:\\Users\\me\\Project Files\\", "Project Files"],
		["\\\\server\\share\\folder\\", "folder"],
		["C:/work/src/file.ts", "file.ts"],
		["/", "/"],
	])("shows only the last segment of %s, preserving the full title", (value, label) => {
		render(<AttachmentPathChip path={value} />);
		expect(screen.getByRole("button", { name: value })).toHaveTextContent(label);
		expect(screen.getByRole("button")).toHaveAttribute("title", value);
	});

	it.each([["MacIntel", "Reveal in Finder"], ["Win32", "Show in File Explorer"]])("uses the native menu label on %s", async (platform, label) => {
		vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
		render(<AttachmentPathChip path={path} />);
		fireEvent.contextMenu(screen.getByRole("button"), { button: 2 });
		expect(await screen.findByRole("menuitem", { name: label })).toBeInTheDocument();
	});

	it("reveals the path through Electron IPC", async () => {
		const reveal = vi.spyOn(aoBridge.chatAttachment, "path").mockResolvedValue(path);
		render(<AttachmentPathChip path={path} folder />);
		fireEvent.contextMenu(screen.getByRole("button"), { button: 2 });
		await userEvent.click(await screen.findByRole("menuitem", { name: /Finder|File Explorer|file manager/ }));
		expect(reveal).toHaveBeenCalledWith({ path, action: "reveal", sessionId: undefined });
	});

	it("opens a file through the existing side-panel callback", async () => {
		const open = vi.fn();
		render(<AttachmentPathChip path={path} actions={{ onOpenFile: open }} />);
		fireEvent.contextMenu(screen.getByRole("button"), { button: 2 });
		await userEvent.click(await screen.findByRole("menuitem", { name: "Open in side panel" }));
		expect(open).toHaveBeenCalledWith(path);
	});

	it.each([false, true])("requests the actual Files side panel (folder: %s)", async (folder) => {
		useUiStore.setState({ workspaceFileOpenRequest: null });
		const openCenter = vi.fn();
		render(<AttachmentPathChip path={path} folder={folder} actions={{ sessionId: "ao-1", hostId: "host-a", remoteHost: true, onOpenFile: openCenter }} />);
		fireEvent.contextMenu(screen.getByRole("button"), { button: 2 });
		await userEvent.click(await screen.findByRole("menuitem", { name: "Open in side panel" }));
		expect(useUiStore.getState().workspaceFileOpenRequest).toMatchObject({ sessionId: "ao-1", hostId: "host-a", path, source: "panel", ...(folder ? { directory: true } : {}) });
		expect(openCenter).not.toHaveBeenCalled();
	});

	it.each([["ContextMenu", path], ["F10", "C:\\work\\Project Files\\"]])("opens the menu with %s and copies the full absolute path", async (key, target) => {
		const copy = vi.spyOn(aoBridge.clipboard, "writeText").mockResolvedValue();
		render(<AttachmentPathChip path={target} folder />);
		const chip = screen.getByRole("button");
		chip.focus();
		fireEvent.keyDown(chip, { key, shiftKey: key === "F10" });
		await userEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));
		expect(copy).toHaveBeenCalledWith(target);
	});

	it("resolves a staged file against its local session before copying", async () => {
		const resolve = vi.spyOn(aoBridge.chatAttachment, "path").mockResolvedValue("/work/.ao/attachments/attachment-a.txt");
		const copy = vi.spyOn(aoBridge.clipboard, "writeText").mockResolvedValue();
		const staged = ".ao/attachments/attachment-a.txt";
		render(<AttachmentPathChip path={staged} actions={{ sessionId: "ao-1" }} />);
		fireEvent.contextMenu(screen.getByRole("button"), { button: 2 });
		await userEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));
		expect(resolve).toHaveBeenCalledWith({ path: staged, sessionId: "ao-1", action: "resolve" });
		expect(copy).toHaveBeenCalledWith("/work/.ao/attachments/attachment-a.txt");
	});

	it("does not resolve a remote path on this machine", async () => {
		const resolve = vi.spyOn(aoBridge.chatAttachment, "path");
		resolve.mockClear();
		render(<AttachmentPathChip path=".ao/attachments/attachment-a.txt" actions={{ sessionId: "remote-1", remoteHost: true }} />);
		fireEvent.contextMenu(screen.getByRole("button"), { button: 2 });
		expect(await screen.findByRole("menuitem", { name: "Copy path" })).toHaveAttribute("aria-disabled", "true");
		expect(screen.queryByRole("menuitem", { name: /Finder|File Explorer|file manager/ })).toBeNull();
		expect(resolve).not.toHaveBeenCalled();
	});
});
