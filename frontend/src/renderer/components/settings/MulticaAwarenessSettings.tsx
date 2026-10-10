import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AwarenessCommand, AwarenessCommandFailure, AwarenessServerState, MulticaCredentialSource } from "../../../shared/multica-awareness";
import type { MessageKey } from "../../i18n/messages";
import { useMulticaAwarenessStore } from "../../stores/multica-awareness-store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { MulticaActivityLog } from "./MulticaActivityLog";
import { SettingsRow } from "./SettingsRow";
import { SettingsOptionMenu, type SettingsOption } from "./SettingsOptionMenu";
import { SettingsSection } from "./SettingsSection";

const statusKeys: Record<AwarenessServerState["status"], MessageKey> = {
	off: "multica.awareness.status.off",
	no_credential: "multica.awareness.status.no_credential",
	connecting: "multica.awareness.status.connecting",
	live: "multica.awareness.status.live",
	degraded: "multica.awareness.status.degraded",
	signed_out: "multica.awareness.status.signed_out",
	unreachable: "multica.awareness.status.unreachable",
	paused: "multica.awareness.status.paused",
};

const workspaceStateKeys: Record<AwarenessServerState["workspaces"][number]["state"], MessageKey> = {
	idle: "multica.awareness.workspaceState.idle",
	connecting: "multica.awareness.workspaceState.connecting",
	authenticating: "multica.awareness.workspaceState.authenticating",
	live: "multica.awareness.workspaceState.live",
	backoff: "multica.awareness.workspaceState.backoff",
	no_access: "multica.awareness.workspaceState.no_access",
	gone: "multica.awareness.workspaceState.gone",
};

const failureKeys: Record<AwarenessCommandFailure, MessageKey> = {
	invalid_request: "multica.awareness.error.invalid_request",
	kill_switch: "multica.awareness.error.kill_switch",
	unknown_server: "multica.awareness.error.unknown_server",
	invalid_server: "multica.awareness.error.invalid_server",
	socket_cap: "multica.awareness.error.socket_cap",
	save_failed: "multica.awareness.error.save_failed",
};

/**
 * Settings > General > Multica > Awareness. Everything is off until the user
 * switches on the master switch, then a server, then each workspace. AO only
 * reads from Multica here; the credential choices say what it may use to do so.
 */
export function MulticaAwarenessSettings() {
	const { t } = useTranslation();
	const state = useMulticaAwarenessStore((store) => store.state);
	const load = useMulticaAwarenessStore((store) => store.load);
	const command = useMulticaAwarenessStore((store) => store.command);
	const [error, setError] = useState<AwarenessCommandFailure | null>(null);
	const [consentFor, setConsentFor] = useState<string | null>(null);
	const [tokens, setTokens] = useState<Record<string, string>>({});
	const [newUrl, setNewUrl] = useState("");

	useEffect(() => {
		void load();
	}, [load]);

	const run = async (next: AwarenessCommand): Promise<boolean> => {
		const result = await command(next);
		setError(result.ok ? null : result.reason);
		return result.ok;
	};

	const sourceOptions: SettingsOption<MulticaCredentialSource>[] = [
		{ value: "profile", label: t("multica.awareness.credential.profile") },
		{ value: "pasted", label: t("multica.awareness.credential.pasted") },
		{ value: "page", label: t("multica.awareness.credential.page") },
	];

	return (
		<SettingsSection title={t("multica.awareness.title")} grouped>
			<SettingsRow label={t("multica.awareness.master")} description={t("multica.awareness.masterDescription")}>
				<Switch
					checked={state.masterEnabled}
					disabled={state.killSwitch}
					aria-label={t("multica.awareness.master")}
					onCheckedChange={(enabled) => void run({ type: "setMaster", enabled })}
				/>
			</SettingsRow>
			{state.killSwitch ? <p className="px-3 pb-2 text-caption leading-4 text-muted-foreground">{t("multica.awareness.killSwitch")}</p> : null}
			{error ? (
				<p role="alert" className="px-3 pb-2 text-caption leading-4 text-error">
					{t(failureKeys[error])}
				</p>
			) : null}

			{state.servers.map((server) => (
				<div key={server.serverKey} className="flex flex-col" data-testid="multica-awareness-server">
					<SettingsRow label={server.label} description={t(statusKeys[server.status])}>
						<div className="flex items-center gap-2">
							<Switch
								checked={server.enabled}
								disabled={state.killSwitch}
								aria-label={t("multica.awareness.serverOn", { server: server.label })}
								onCheckedChange={(enabled) => void run({ type: "setServerEnabled", serverKey: server.serverKey, enabled })}
							/>
							<Button size="sm" type="button" variant="ghost" onClick={() => void run({ type: "removeServer", serverKey: server.serverKey })}>
								{t("multica.awareness.remove")}
							</Button>
						</div>
					</SettingsRow>
					<SettingsRow label={t("multica.awareness.credential")}>
						<SettingsOptionMenu
							aria-label={t("multica.awareness.credential")}
							value={server.credentialSource}
							options={sourceOptions}
							onChange={(source) => void run({ type: "setCredentialSource", serverKey: server.serverKey, source })}
						/>
					</SettingsRow>
					{server.credentialSource === "profile" ? (
						<div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-caption leading-4 text-muted-foreground">
							<span>{server.consentGranted ? t("multica.awareness.consent.granted") : t("multica.awareness.consent.needed")}</span>
							{server.consentGranted ? (
								<Button size="sm" type="button" variant="outline" onClick={() => void run({ type: "revokeConsent", serverKey: server.serverKey })}>
									{t("multica.awareness.consent.revoke")}
								</Button>
							) : (
								<Button size="sm" type="button" variant="outline" onClick={() => setConsentFor(server.serverKey)}>
									{t("multica.awareness.consent.review")}
								</Button>
							)}
						</div>
					) : null}
					{server.credentialSource === "pasted" ? (
						<div className="flex flex-col gap-1 px-3 pb-2">
							<SettingsRow label={t("multica.awareness.token")}>
								<input
									type="password"
									autoComplete="off"
									spellCheck={false}
									className="h-8 w-64 rounded-md border border-border bg-background px-2 text-xs"
									aria-label={t("multica.awareness.token")}
									placeholder={t("multica.awareness.tokenPlaceholder")}
									value={tokens[server.serverKey] ?? ""}
									onChange={(event) => setTokens((current) => ({ ...current, [server.serverKey]: event.target.value }))}
								/>
							</SettingsRow>
							<div className="flex flex-wrap items-center gap-2 text-caption leading-4 text-muted-foreground">
								<Button
									size="sm"
									type="button"
									disabled={(tokens[server.serverKey] ?? "").trim() === ""}
									onClick={async () => {
										if (await run({ type: "setToken", serverKey: server.serverKey, token: (tokens[server.serverKey] ?? "").trim() })) {
											setTokens((current) => ({ ...current, [server.serverKey]: "" }));
										}
									}}
								>
									{t("multica.awareness.tokenSave")}
								</Button>
								{server.hasPastedToken ? (
									<>
										<span>{state.tokenStoragePersistent ? t("multica.awareness.tokenStored") : t("multica.awareness.tokenMemory")}</span>
										<Button size="sm" type="button" variant="ghost" onClick={() => void run({ type: "clearToken", serverKey: server.serverKey })}>
											{t("multica.awareness.tokenClear")}
										</Button>
									</>
								) : null}
							</div>
						</div>
					) : null}
					{server.credentialSource === "page" ? <p className="px-3 pb-2 text-caption leading-4 text-muted-foreground">{t("multica.awareness.pageNote")}</p> : null}

					<div className="flex items-center gap-2 px-3 pb-1 pt-1">
						<span className="text-xs font-medium text-muted-foreground">{t("multica.awareness.workspaces")}</span>
						<Button size="sm" type="button" variant="ghost" disabled={server.status === "off"} onClick={() => void run({ type: "refreshWorkspaces", serverKey: server.serverKey })}>
							{t("multica.awareness.refresh")}
						</Button>
					</div>
					{server.workspaces.length === 0 ? <p className="px-3 pb-2 text-caption leading-4 text-muted-foreground">{t("multica.awareness.noWorkspaces")}</p> : null}
					{server.workspaces.map((workspace) => (
						<SettingsRow key={workspace.workspaceId} label={workspace.name} description={`${t(workspaceStateKeys[workspace.state])}${workspace.partial ? ` · ${t("multica.awareness.partial")}` : ""}`}>
							<Switch
								checked={workspace.watch}
								disabled={state.killSwitch}
								aria-label={t("multica.awareness.watchWorkspace", { name: workspace.name })}
								onCheckedChange={(watch) => void run({ type: "setWorkspaceWatch", serverKey: server.serverKey, workspaceId: workspace.workspaceId, watch })}
							/>
						</SettingsRow>
					))}
				</div>
			))}

			<div className="flex flex-col gap-2 px-3 py-2">
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" type="button" variant="outline" onClick={() => void run({ type: "addServer", mode: "cloud", customUrl: "", apiUrl: "" })}>
						{t("multica.awareness.addCloud")}
					</Button>
					<input
						className="h-8 min-w-48 flex-1 rounded-md border border-border bg-background px-2 text-xs"
						aria-label={t("multica.awareness.addUrl")}
						placeholder={t("multica.awareness.addUrl")}
						value={newUrl}
						onChange={(event) => setNewUrl(event.target.value)}
					/>
					<Button
						size="sm"
						type="button"
						variant="outline"
						disabled={newUrl.trim() === ""}
						onClick={async () => {
							if (await run({ type: "addServer", mode: "local", customUrl: newUrl.trim(), apiUrl: "" })) setNewUrl("");
						}}
					>
						{t("multica.awareness.addServer")}
					</Button>
				</div>
				<p className="text-caption leading-4 text-muted-foreground">{t("multica.awareness.socketsNote", { max: state.maxSockets })}</p>
			</div>

			<MulticaActivityLog />

			<ConfirmDialog
				open={consentFor !== null}
				title={t("multica.awareness.consent.title")}
				description={t("multica.awareness.consent.body")}
				confirmLabel={t("multica.awareness.consent.allow")}
				onOpenChange={(open) => {
					if (!open) setConsentFor(null);
				}}
				onConfirm={() => {
					const serverKey = consentFor;
					setConsentFor(null);
					if (serverKey) void run({ type: "grantConsent", serverKey });
				}}
			/>
		</SettingsSection>
	);
}
