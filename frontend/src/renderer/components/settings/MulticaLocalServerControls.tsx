import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LocalServerErrorCode, LocalServerResult, LocalServerState, LocalServerStatus } from "../../../shared/multica-local-server";
import { aoBridge } from "../../lib/bridge";
import type { MessageKey } from "../../i18n/messages";
import { Button } from "../ui/button";
import { SettingsRow } from "./SettingsRow";

const LOG_REFRESH_MS = 3000;

// Setting up is one quick local write, so it is not offered a Cancel button.
const BUSY_STATES: ReadonlySet<LocalServerState> = new Set(["setting_up", "docker_starting", "starting_server", "stopping", "restarting"]);
const START_STATES: ReadonlySet<LocalServerState> = new Set(["stopped", "unhealthy", "docker_not_running"]);
const STOP_STATES: ReadonlySet<LocalServerState> = new Set(["starting", "healthy", "unhealthy"]);
const LOG_STATES: ReadonlySet<LocalServerState> = new Set(["stopped", "starting", "healthy", "unhealthy"]);

const stateKeys: Record<Exclude<LocalServerState, "unavailable">, MessageKey> = {
	no_folder: "multica.localServer.state.no_folder",
	invalid_folder: "multica.localServer.state.invalid_folder",
	needs_setup: "multica.localServer.state.needs_setup",
	unknown: "multica.localServer.state.unknown",
	docker_not_installed: "multica.localServer.state.docker_not_installed",
	compose_missing: "multica.localServer.state.compose_missing",
	docker_not_running: "multica.localServer.state.docker_not_running",
	docker_starting: "multica.localServer.state.docker_starting",
	stopped: "multica.localServer.state.stopped",
	starting: "multica.localServer.state.starting",
	healthy: "multica.localServer.state.healthy",
	unhealthy: "multica.localServer.state.unhealthy",
	port_conflict: "multica.localServer.state.port_conflict",
	running_elsewhere: "multica.localServer.state.running_elsewhere",
	setting_up: "multica.localServer.state.setting_up",
	starting_server: "multica.localServer.state.starting_server",
	stopping: "multica.localServer.state.stopping",
	restarting: "multica.localServer.state.restarting",
};

const hintKeys: Partial<Record<LocalServerState, MessageKey>> = {
	no_folder: "multica.localServer.hint.no_folder",
	invalid_folder: "multica.localServer.hint.invalid_folder",
	needs_setup: "multica.localServer.hint.needs_setup",
	unknown: "multica.localServer.hint.unknown",
	docker_not_installed: "multica.localServer.hint.docker_not_installed",
	compose_missing: "multica.localServer.hint.compose_missing",
	starting: "multica.localServer.hint.starting",
	unhealthy: "multica.localServer.hint.unhealthy",
	port_conflict: "multica.localServer.hint.port_conflict",
	running_elsewhere: "multica.localServer.hint.running_elsewhere",
};

const errorKeys: Record<Exclude<LocalServerErrorCode, "cancelled">, MessageKey> = {
	busy: "multica.localServer.error.busy",
	unavailable: "multica.localServer.error.unavailable",
	no_folder: "multica.localServer.error.no_folder",
	invalid_folder: "multica.localServer.error.invalid_folder",
	needs_setup: "multica.localServer.error.needs_setup",
	inspect_failed: "multica.localServer.error.inspect_failed",
	already_set_up: "multica.localServer.error.already_set_up",
	setup_failed: "multica.localServer.error.setup_failed",
	docker_not_installed: "multica.localServer.error.docker_not_installed",
	compose_missing: "multica.localServer.error.compose_missing",
	docker_not_running: "multica.localServer.error.docker_not_running",
	docker_start_timeout: "multica.localServer.error.docker_start_timeout",
	port_conflict: "multica.localServer.error.port_conflict",
	timeout: "multica.localServer.error.timeout",
	command_failed: "multica.localServer.error.command_failed",
	no_detected_folder: "multica.localServer.error.no_detected_folder",
	bad_request: "multica.localServer.error.bad_request",
};

type Failure = { code: LocalServerErrorCode; detail?: string };

/**
 * Start, stop and restart for the self-hosted Multica SERVER (Docker Compose on this
 * computer). Shown only for a local server address; the main process answers
 * `unavailable` for Cloud or a remote address and this renders nothing then. The poll
 * runs only while this block is mounted. Log lines live in this component's state only.
 */
export function MulticaLocalServerControls() {
	const { t } = useTranslation();
	const [status, setStatus] = useState<LocalServerStatus | null>(null);
	const [failure, setFailure] = useState<Failure | null>(null);
	const [calling, setCalling] = useState(false);
	const [logOpen, setLogOpen] = useState(false);
	const [logLines, setLogLines] = useState<string[] | null>(null);
	const [logFailure, setLogFailure] = useState<Failure | null>(null);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		const server = aoBridge.multica.localServer;
		const unsubscribe = server.onStatus((next) => {
			if (mounted.current) setStatus(next);
		});
		void server.getState().then((next) => {
			if (mounted.current) setStatus(next);
		});
		void server.watch(true);
		return () => {
			mounted.current = false;
			unsubscribe();
			void server.watch(false);
		};
	}, []);

	const state = status?.state ?? "unavailable";
	const logAvailable = LOG_STATES.has(state);

	const refreshLog = useCallback(async () => {
		const result = await aoBridge.multica.localServer.getLogs("backend");
		if (!mounted.current) return;
		if (result.ok) {
			setLogLines(result.lines);
			setLogFailure(null);
		} else {
			setLogFailure({ code: result.code, ...(result.detail ? { detail: result.detail } : {}) });
		}
	}, []);

	useEffect(() => {
		if (!logOpen || !logAvailable) return undefined;
		void refreshLog();
		const timer = setInterval(() => {
			if (document.visibilityState !== "hidden") void refreshLog();
		}, LOG_REFRESH_MS);
		return () => clearInterval(timer);
	}, [logOpen, logAvailable, refreshLog]);

	useEffect(() => {
		if (!logAvailable) {
			setLogOpen(false);
			setLogLines(null);
		}
	}, [logAvailable]);

	if (!status || status.state === "unavailable") return null;

	const busy = BUSY_STATES.has(status.state);
	const disabled = calling || busy;
	const canStart = !disabled && START_STATES.has(status.state) && (status.state !== "docker_not_running" || status.canLaunchDocker);
	const canStopRestart = !disabled && STOP_STATES.has(status.state);

	const act = async (call: () => Promise<LocalServerResult>) => {
		setCalling(true);
		setFailure(null);
		try {
			const result = await call();
			if (!mounted.current) return;
			if (!result.ok && result.code !== "cancelled") setFailure({ code: result.code, ...(result.detail ? { detail: result.detail } : {}) });
		} catch {
			if (mounted.current) setFailure({ code: "command_failed" });
		} finally {
			if (mounted.current) setCalling(false);
		}
	};

	const server = aoBridge.multica.localServer;
	const hintKey: MessageKey | undefined =
		status.state === "docker_not_running"
			? status.canLaunchDocker
				? "multica.localServer.hint.docker_not_running_mac"
				: "multica.localServer.hint.docker_not_running"
			: hintKeys[status.state];
	const shownFailure = failure ?? status.error;
	const failureKey = (code: LocalServerErrorCode): MessageKey | null => (code === "cancelled" ? null : errorKeys[code]);
	const startLabel = status.state === "docker_not_running" && status.canLaunchDocker ? t("multica.localServer.startWithDocker") : t("multica.localServer.start");

	return (
		<div className="flex flex-col gap-1 border-t border-border/60 pt-2" role="group" aria-labelledby="multica-local-server-title" aria-busy={busy || calling}>
			<div className="flex flex-col gap-1 px-3 pt-1">
				<h4 id="multica-local-server-title" className="text-sm font-medium leading-5 text-settings-label">
					{t("multica.localServer.title")}
				</h4>
				<p className="text-caption leading-4 text-muted-foreground">{t("multica.localServer.description")}</p>
			</div>
			<SettingsRow label={t("multica.localServer.status")}>
				<span role="status" aria-live="polite" className="text-sm leading-5 text-settings-label">
					{t(stateKeys[status.state])}
				</span>
			</SettingsRow>
			{hintKey ? <p className="px-3 text-caption leading-4 text-muted-foreground">{t(hintKey)}</p> : null}
			<SettingsRow label={t("multica.localServer.folder")}>
				<div className="flex min-w-0 items-center gap-2">
					<code className="min-w-0 select-text truncate text-xs text-settings-label" title={status.folder ?? undefined}>
						{status.folder ?? t("multica.localServer.folderNone")}
					</code>
					<Button size="sm" type="button" variant="outline" disabled={disabled} onClick={() => void act(() => server.chooseFolder())}>
						{t("multica.localServer.chooseFolder")}
					</Button>
				</div>
			</SettingsRow>
			{status.detectedFolder ? (
				<div className="flex items-center gap-2 px-3 text-caption leading-4 text-muted-foreground">
					<span className="min-w-0 break-all">{t("multica.localServer.detected", { path: status.detectedFolder })}</span>
					<Button size="sm" type="button" variant="outline" disabled={disabled} onClick={() => void act(() => server.useDetectedFolder())}>
						{t("multica.localServer.useDetected")}
					</Button>
				</div>
			) : null}
			<div className="flex flex-wrap items-center gap-2 px-3 py-2">
				{status.state === "needs_setup" ? (
					<Button size="sm" type="button" disabled={disabled} onClick={() => void act(() => server.setup())}>
						{t("multica.localServer.setup")}
					</Button>
				) : null}
				<Button size="sm" type="button" disabled={!canStart} onClick={() => void act(() => server.start())}>
					{startLabel}
				</Button>
				<Button size="sm" type="button" variant="outline" disabled={!canStopRestart} onClick={() => void act(() => server.stop())}>
					{t("multica.localServer.stop")}
				</Button>
				<Button size="sm" type="button" variant="outline" disabled={!canStopRestart} onClick={() => void act(() => server.restart())}>
					{t("multica.localServer.restart")}
				</Button>
				{busy && status.state !== "setting_up" ? (
					<Button size="sm" type="button" variant="ghost" onClick={() => void server.cancel()}>
						{t("multica.localServer.cancel")}
					</Button>
				) : null}
				<Button
					size="sm"
					type="button"
					variant="ghost"
					disabled={!logAvailable}
					aria-expanded={logOpen}
					aria-controls="multica-local-server-log"
					onClick={() => setLogOpen((open) => !open)}
				>
					{logOpen ? t("multica.localServer.hideLog") : t("multica.localServer.showLog")}
				</Button>
			</div>
			{shownFailure && failureKey(shownFailure.code) ? (
				<div role="alert" className="flex flex-col gap-1 px-3 text-caption leading-4 text-error">
					<p>{t(failureKey(shownFailure.code) as MessageKey)}</p>
					{shownFailure.detail ? (
						<details>
							<summary className="cursor-pointer">{t("multica.localServer.error.details")}</summary>
							<pre className="mt-1 max-h-32 select-text overflow-auto whitespace-pre-wrap break-all text-muted-foreground">{shownFailure.detail}</pre>
						</details>
					) : null}
				</div>
			) : null}
			{status.portMismatch ? (
				<p className="px-3 text-caption leading-4 text-muted-foreground">
					{t("multica.localServer.portMismatch", { published: status.portMismatch.published, configured: status.portMismatch.configured })}
				</p>
			) : null}
			<p className="px-3 text-caption leading-4 text-muted-foreground">{t("multica.localServer.restartNote")}</p>
			<p className="px-3 text-caption leading-4 text-muted-foreground">{t("multica.localServer.afterStart")}</p>
			{logOpen && logAvailable ? (
				<div id="multica-local-server-log" className="flex flex-col gap-1 px-3 pb-2">
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs font-medium text-settings-label">{t("multica.localServer.log.title")}</span>
						<Button
							size="sm"
							type="button"
							variant="ghost"
							disabled={!logLines || logLines.length === 0}
							onClick={() => void navigator.clipboard?.writeText((logLines ?? []).join("\n")).catch(() => undefined)}
						>
							{t("multica.localServer.copyLog")}
						</Button>
					</div>
					<pre
						tabIndex={0}
						aria-label={t("multica.localServer.log.title")}
						className="max-h-60 select-text overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-2 text-xs leading-4"
					>
						{logFailure && failureKey(logFailure.code)
							? t(failureKey(logFailure.code) as MessageKey)
							: logLines && logLines.length > 0
								? logLines.join("\n")
								: t("multica.localServer.log.empty")}
					</pre>
					<p className="text-caption leading-4 text-muted-foreground">{t("multica.localServer.log.caption")}</p>
				</div>
			) : null}
		</div>
	);
}
