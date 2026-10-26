import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { DICTATION_CHANNEL, DICTATION_EVENT_CHANNEL, dictationLocale, type DictationEngine, type DictationError } from "../shared/dictation";

export function registerDictationIpc({ ipcMain, isTrustedSender, createEngine }: {
	ipcMain: Pick<IpcMain, "handle">;
	isTrustedSender: (senderId: number) => boolean;
	createEngine: () => DictationEngine;
}): () => void {
	let active: { id: string; owner: WebContents; engine: DictationEngine; cleanup: () => void } | undefined;
	const cancel = () => {
		const previous = active;
		active = undefined;
		previous?.cleanup();
		previous?.engine.cancel();
	};
	ipcMain.handle(DICTATION_CHANNEL, (event: IpcMainInvokeEvent, command: unknown, id: unknown, inputLocale: unknown) => {
		if (!isTrustedSender(event.sender.id) || event.senderFrame !== event.sender.mainFrame) throw new Error("Untrusted dictation request");
		if (command === "availability") {
			const locale = dictationLocale(inputLocale);
			return locale ? createEngine().availability(locale) : { available: false, error: "unavailable" };
		}
		if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid dictation request");
		if (command === "start") {
			const locale = dictationLocale(inputLocale);
			if (!locale) return { error: "unavailable" };
			if (active) return { error: "busy" };
			const engine = createEngine();
			const owner = event.sender;
			const navigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => { if (mainFrame) cancel(); };
			const cleanup = () => {
				owner.removeListener("destroyed", cancel);
				owner.removeListener("render-process-gone", cancel);
				owner.removeListener("did-start-navigation", navigation);
			};
			owner.once("destroyed", cancel);
			owner.once("render-process-gone", cancel);
			owner.on("did-start-navigation", navigation);
			const recording = { id, owner, engine, cleanup };
			active = recording;
			try {
				engine.start(locale, (update) => {
					if (active !== recording) return;
					if (update.type !== "recording") cancel();
					if (!owner.isDestroyed()) owner.send(DICTATION_EVENT_CHANNEL, { ...update, id });
				});
			} catch {
				cancel();
				return { error: "failed" satisfies DictationError };
			}
			return {};
		}
		if (active?.id !== id || active.owner !== event.sender) return undefined;
		if (command === "stop") active.engine.stop();
		else if (command === "cancel") cancel();
		else throw new Error("Invalid dictation command");
		return undefined;
	});
	return cancel;
}
