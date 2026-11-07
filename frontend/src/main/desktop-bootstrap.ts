import { app } from "electron";
import os from "node:os";
import path from "node:path";
import { createDesktopStartup, desktopProcessStart, setDesktopStartup } from "./desktop-startup";

const directory = process.env.AO_RUN_FILE?.trim()
	? path.dirname(path.resolve(process.env.AO_RUN_FILE.trim()))
	: process.env.AO_DATA_DIR?.trim()
		? path.resolve(process.env.AO_DATA_DIR.trim())
		: path.join(os.homedir(), ".ao", ...(app.isPackaged ? [] : ["dev"]));

export const desktopStartup = createDesktopStartup({
	directory, executable: process.execPath, appVersion: app.getVersion(), processStart: "",
});
desktopStartup.identify(desktopProcessStart());
setDesktopStartup(desktopStartup);
app.once("will-quit", () => desktopStartup.dispose());
