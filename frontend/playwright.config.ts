import { defineConfig } from "@playwright/test";

// Overridable because 5173 is not ours alone: another worktree's
// `electron-forge start` also listens there, and with reuseExistingServer the
// suite silently runs against ITS renderer — which is built for Electron and
// fails in confusing, unrelated ways. Set AO_E2E_PORT to run alongside one.
const port = Number(process.env.AO_E2E_PORT ?? 5173);
// Exercise the packaged renderer's API/effect paths with an injected preload.
const realRenderer = process.env.AO_E2E_REAL_RENDERER === "1";

export default defineConfig({
	testDir: "e2e",
	use: {
		baseURL: `http://127.0.0.1:${port}`,
	},
	webServer: {
		// Serve only the renderer. The normal API mode uses an injected preload
		// while keeping lifecycle effects active; neither mode launches Electron.
		command: realRenderer
			? `node node_modules/vite/bin/vite.js --config vite.renderer.config.ts --port ${port} --host 127.0.0.1`
			: `npm run dev:web -- --port ${port} --host 127.0.0.1`,
		env: realRenderer ? { VITE_NO_ELECTRON: "0" } : undefined,
		port,
		reuseExistingServer: !realRenderer && !process.env.CI,
	},
});
