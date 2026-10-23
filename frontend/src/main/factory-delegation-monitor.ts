type RunReference = { projectId: string; taskId: string; delegationId?: string };

export function createFactoryDelegationMonitor(options: {
	origin: () => string | null;
	fetch: typeof fetch;
	restore: (reference: RunReference) => Promise<void>;
}) {
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: Promise<void> | undefined;
	async function scan() {
		if (disposed || pending) return pending;
		pending = (async () => {
			await Promise.resolve();
			try {
				const base = options.origin();
				if (!base) return;
				const origin = new URL(base);
				if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return;
				const response = await options.fetch(`${origin.origin}/api/v1/runs/monitoring`, { method: "GET", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(5000) });
				if (!response.ok || disposed) return;
				const body: unknown = await response.json();
				if (!body || typeof body !== "object" || !("runs" in body) || !Array.isArray(body.runs)) return;
				for (const row of body.runs) {
					if (disposed) return;
					if (row && typeof row.projectId === "string" && typeof row.taskId === "string" && typeof row.delegationId === "string" && row.delegationId) {
						try { await options.restore(row); } catch {}
					}
				}
			} catch {} finally {
				pending = undefined;
				if (!disposed) timer = setTimeout(() => void scan(), 30_000);
			}
		})();
		return pending;
	}
	void scan();
	return { scan, dispose() { disposed = true; clearTimeout(timer); } };
}
