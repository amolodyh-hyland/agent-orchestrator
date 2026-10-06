import * as realBridge from "../src/main/multica-desktop-bridge.ts";

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function makeBridgeOptions() {
	const handlers = new Map();
	const listeners = new Map();
	return {
		ipc: {
			handle: (channel, handler) => handlers.set(channel, handler),
			on: (channel, listener) => listeners.set(channel, listener),
			removeHandler: (channel) => handlers.delete(channel),
			removeListener: (channel, listener) => {
				if (listeners.get(channel) === listener) listeners.delete(channel);
			},
		},
		handlers,
		listeners,
		isMulticaSender: () => true,
		getAppInfo: () => ({ version: "0.0.0", os: "unknown" }),
		getRuntimeConfig: () => ({ ok: false, error: { message: "Unavailable" } }),
		getHostName: () => "",
		daemon: {
			getStatus: () => undefined,
			start: () => undefined,
			stop: () => undefined,
			restart: () => undefined,
			probeRuntimes: () => undefined,
			isInstalled: () => undefined,
			refreshBinary: () => undefined,
			startPolling: () => undefined,
			dispose: () => undefined,
			startLogStream: () => undefined,
			stopLogStream: () => undefined,
		},
		openExternal: async () => undefined,
		send: () => undefined,
		notifications: {
			showNotification: () => undefined,
			reportAuthSession: () => false,
			setBadge: () => undefined,
		},
	};
}

function allowlistMismatch(allowlist, registered) {
	const allowlistedOnly = allowlist.filter((channel) => !registered.includes(channel));
	const registeredOnly = registered.filter((channel) => !allowlist.includes(channel));
	if (allowlistedOnly.length === 0 && registeredOnly.length === 0) return null;
	return {
		code: "allowlist-mismatch",
		message: `Channels only in allowlist: ${allowlistedOnly.join(", ") || "(none)"}; channels only registered: ${registeredOnly.join(", ") || "(none)"}`,
	};
}

export function collectBridgeInventory({ bridge = realBridge } = {}) {
	const allowlist = [...bridge.multicaBridgeChannels()].sort();
	const issues = [];
	const options = makeBridgeOptions();
	let instance;
	let served = {};

	try {
		instance = bridge.createMulticaDesktopBridge(options);
	} catch (error) {
		issues.push({ code: "bridge-error", message: errorMessage(error) });
		return { served, allowlist, issues };
	}

	try {
		for (const channel of options.handlers.keys()) served[channel] = "invoke";
		for (const [channel, listener] of options.listeners) {
			let sync = false;
			const event = {
				sender: { id: 1 },
				set returnValue(_value) {
					sync = true;
				},
			};
			try {
				listener(event, undefined);
			} catch {
				// A listener failure does not change the IPC kind or stop the inventory.
			}
			served[channel] = sync ? "sendSync" : "send";
		}
		served = Object.fromEntries(Object.entries(served).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
		const registered = Object.keys(served);
		const mismatch = allowlistMismatch(allowlist, registered);
		if (mismatch) issues.push(mismatch);
	} finally {
		instance.dispose();
	}

	return { served, allowlist, issues };
}
