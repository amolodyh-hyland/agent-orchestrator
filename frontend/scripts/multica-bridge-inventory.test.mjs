// @vitest-environment node
import { describe, expect, it } from "vitest";
import { collectBridgeInventory } from "./multica-bridge-inventory.mjs";

describe("collectBridgeInventory", () => {
	it("records the real bridge surface and its IPC kinds", () => {
		const inventory = collectBridgeInventory();
		const kinds = Object.values(inventory.served);

		expect(kinds).toHaveLength(39);
		expect(kinds.filter((kind) => kind === "invoke")).toHaveLength(27);
		expect(kinds.filter((kind) => kind === "send")).toHaveLength(9);
		expect(kinds.filter((kind) => kind === "sendSync")).toHaveLength(3);
		expect(inventory.served["app:get-info"]).toBe("sendSync");
		expect(inventory.served["runtime-config:get"]).toBe("sendSync");
		expect(inventory.served["freeze:get-last"]).toBe("sendSync");
		expect(inventory.allowlist).toEqual(Object.keys(inventory.served));
		expect(inventory.issues).toEqual([]);
		expect(inventory.served["shell:openExternal"]).toBe("invoke");
		expect(inventory.served["notification:show"]).toBe("send");
		expect(inventory.served["daemon:start-log-stream"]).toBe("send");
	});

	it("classifies injected invoke, send, and sendSync registrations", () => {
		let disposeCalls = 0;
		const bridge = {
			multicaBridgeChannels: () => ["sync", "plain", "invoke"],
			createMulticaDesktopBridge: ({ ipc }) => {
				ipc.handle("invoke", () => undefined);
				ipc.on("plain", () => undefined);
				ipc.on("sync", (event) => {
					event.returnValue = "ready";
				});
				return { dispose: () => disposeCalls++ };
			},
		};

		expect(collectBridgeInventory({ bridge })).toEqual({
			served: { invoke: "invoke", plain: "send", sync: "sendSync" },
			allowlist: ["invoke", "plain", "sync"],
			issues: [],
		});
		expect(disposeCalls).toBe(1);
	});

	it("reports allowlist channels on either side of a mismatch", () => {
		const bridge = {
			multicaBridgeChannels: () => ["allowed", "extra"],
			createMulticaDesktopBridge: ({ ipc }) => {
				ipc.handle("allowed", () => undefined);
				ipc.on("registered", () => undefined);
				return { dispose: () => undefined };
			},
		};

		const inventory = collectBridgeInventory({ bridge });
		expect(inventory.issues).toEqual([
			{
				code: "allowlist-mismatch",
				message: "Channels only in allowlist: extra; channels only registered: registered",
			},
		]);
	});

	it("treats a throwing listener as send and continues probing", () => {
		let disposeCalls = 0;
		const bridge = {
			multicaBridgeChannels: () => ["throws", "sync"],
			createMulticaDesktopBridge: ({ ipc }) => {
				ipc.on("throws", () => {
					throw new Error("probe failed");
				});
				ipc.on("sync", (event) => {
					event.returnValue = true;
				});
				return { dispose: () => disposeCalls++ };
			},
		};

		const inventory = collectBridgeInventory({ bridge });
		expect(inventory.served).toEqual({ throws: "send", sync: "sendSync" });
		expect(inventory.issues).toEqual([]);
		expect(disposeCalls).toBe(1);
	});

	it("reports factory errors with an empty served surface", () => {
		const bridge = {
			multicaBridgeChannels: () => ["expected"],
			createMulticaDesktopBridge: () => {
				throw new Error("factory failed");
			},
		};

		expect(collectBridgeInventory({ bridge })).toEqual({
			served: {},
			allowlist: ["expected"],
			issues: [{ code: "bridge-error", message: "factory failed" }],
		});
	});
});
