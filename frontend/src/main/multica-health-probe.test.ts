// @vitest-environment node
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MULTICA_HEALTH_RESPONSE_MAX_BYTES, probeMulticaHealth } from "./multica-health-probe";

const servers: Server[] = [];

async function listen(handler: RequestListener): Promise<{ port: number; server: Server }> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
	return { port: address.port, server };
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		if (!server.listening) continue;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

describe("probeMulticaHealth", () => {
	it("closes a slow-drip response at the wall-clock deadline", async () => {
		let clientClosed!: () => void;
		const closed = new Promise<void>((resolve) => {
			clientClosed = resolve;
		});
		const { port } = await listen((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			const interval = setInterval(() => response.write(" "), 15);
			response.on("close", () => {
				clearInterval(interval);
				clientClosed();
			});
		});
		const startedAt = Date.now();

		expect(await probeMulticaHealth(port, 120)).toBeNull();
		expect(Date.now() - startedAt).toBeLessThan(1000);
		await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("probe left the response socket open")), 1000))]);
	});

	it("destroys a response that exceeds the body cap and stops consuming its stream", async () => {
		let bytesWritten = 0;
		let clientClosed!: () => void;
		const closed = new Promise<void>((resolve) => {
			clientClosed = resolve;
		});
		const { port } = await listen((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			const chunk = Buffer.alloc(32 * 1024, 0x20);
			const interval = setInterval(() => {
				bytesWritten += chunk.length;
				response.write(chunk);
			}, 2);
			response.on("close", () => {
				clearInterval(interval);
				clientClosed();
			});
		});

		expect(await probeMulticaHealth(port, 2000)).toBeNull();
		await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("oversized response socket stayed open")), 1000))]);
		const bytesAtClose = bytesWritten;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(bytesAtClose).toBeGreaterThan(MULTICA_HEALTH_RESPONSE_MAX_BYTES);
		expect(bytesAtClose).toBeLessThan(MULTICA_HEALTH_RESPONSE_MAX_BYTES * 8);
		expect(bytesWritten).toBe(bytesAtClose);
	});

	it("returns an immediate JSON object", async () => {
		const { port } = await listen((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ status: "running", pid: 123, profile: "team/dev" }));
		});

		expect(await probeMulticaHealth(port, 1000)).toEqual({ status: "running", pid: 123, profile: "team/dev" });
	});

	it("returns no usable answer for non-2xx and invalid JSON responses", async () => {
		const non2xx = await listen((_request, response) => {
			response.writeHead(503);
			response.end("unavailable");
		});
		const invalidJson = await listen((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end("{");
		});

		expect(await probeMulticaHealth(non2xx.port, 1000)).toBeNull();
		expect(await probeMulticaHealth(invalidJson.port, 1000)).toBeNull();
	});
});
