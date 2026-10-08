import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	multicaCliSignInCommand,
	resolveMulticaServer,
	type MulticaServerCheckError,
	type MulticaServerMode,
	type MulticaSettings,
} from "../../../shared/multica";
import { aoBridge } from "../../lib/bridge";
import type { MessageKey } from "../../i18n/messages";
import { Button } from "../ui/button";
import { SettingsInputRow, SettingsRow } from "./SettingsRow";
import { SettingsOptionMenu, type SettingsOption } from "./SettingsOptionMenu";
import { SettingsSection } from "./SettingsSection";

const errorKeys: Record<MulticaServerCheckError, MessageKey> = {
	invalid_url: "multica.settings.invalidUrl",
	insecure_http: "multica.settings.error.insecure_http",
	path_not_allowed: "multica.settings.error.path_not_allowed",
	unreachable: "multica.settings.error.unreachable",
	timeout: "multica.settings.error.timeout",
	tls: "multica.settings.error.tls",
	not_multica: "multica.settings.error.not_multica",
	not_ready: "multica.settings.error.not_ready",
};

type Failure = { error: MulticaServerCheckError; forceable: boolean } | "save";

function sameSettings(a: MulticaSettings, b: MulticaSettings): boolean {
	return a.mode === b.mode && a.customUrl === b.customUrl && a.apiUrl === b.apiUrl;
}

export function MulticaSettingsSection() {
	const { t } = useTranslation();
	const [saved, setSaved] = useState<MulticaSettings | null>(null);
	const [draft, setDraft] = useState<MulticaSettings | null>(null);
	const [failure, setFailure] = useState<Failure | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		aoBridge.multica
			.getSettings()
			.then((settings) => {
				if (cancelled) return;
				setSaved(settings);
				setDraft(settings);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	if (!saved || !draft) return <SettingsSection title={t("multica.title")} grouped>{null}</SettingsSection>;

	const modeOptions: SettingsOption<MulticaServerMode>[] = [
		{ value: "cloud", label: t("multica.settings.mode.cloud") },
		{ value: "local", label: t("multica.settings.mode.local") },
	];
	const pending = !sameSettings(saved, draft);
	const draftServer = resolveMulticaServer(draft);
	const savedServer = resolveMulticaServer(saved);
	const serverChanges = pending && (draftServer?.key ?? "") !== (savedServer?.key ?? "");
	const signIn = draftServer ? multicaCliSignInCommand(draftServer) : null;

	const edit = (next: MulticaSettings) => {
		setDraft(next);
		setFailure(null);
	};

	const apply = async (force: boolean) => {
		setBusy(true);
		setFailure(null);
		try {
			const result = await aoBridge.multica.setSettings({
				mode: draft.mode,
				customUrl: draft.customUrl,
				apiUrl: draft.apiUrl,
				...(force ? { force: true } : {}),
			});
			if (result.ok) {
				setSaved(result.settings);
				setDraft(result.settings);
			} else {
				setFailure({ error: result.error, forceable: result.forceable });
			}
		} catch {
			setFailure("save");
		} finally {
			setBusy(false);
		}
	};

	const cancel = () => {
		setDraft(saved);
		setFailure(null);
	};

	return (
		<SettingsSection title={t("multica.title")} grouped>
			<SettingsRow label={t("multica.settings.mode")}>
				<SettingsOptionMenu
					aria-label={t("multica.settings.mode")}
					value={draft.mode}
					options={modeOptions}
					onChange={(mode) => edit({ ...draft, mode })}
					disabled={busy}
				/>
			</SettingsRow>
			{draft.mode === "local" ? (
				<>
					<SettingsInputRow
						id="multica-url"
						label={t("multica.settings.url")}
						value={draft.customUrl}
						// A different address needs its own API address; an old one would point at the previous server.
						onChange={(customUrl) => edit({ ...draft, customUrl, apiUrl: customUrl === saved.customUrl ? saved.apiUrl : "" })}
						onCancel={() => edit({ ...draft, customUrl: saved.customUrl, apiUrl: saved.apiUrl })}
						placeholder={t("multica.settings.notSet")}
					/>
					<SettingsInputRow
						id="multica-api-url"
						label={t("multica.settings.apiUrl")}
						value={draft.apiUrl}
						onChange={(apiUrl) => edit({ ...draft, apiUrl })}
						onCancel={() => edit({ ...draft, apiUrl: saved.apiUrl })}
						placeholder={t("multica.settings.apiUrlAuto")}
					/>
				</>
			) : null}
			{pending ? (
				<div className="flex flex-col gap-2 px-3 py-3">
					{serverChanges ? <p className="text-caption leading-4 text-muted-foreground">{t("multica.settings.switchWarning")}</p> : null}
					<div className="flex items-center gap-2">
						<Button size="sm" type="button" disabled={busy} onClick={() => void apply(false)}>
							{busy ? t("multica.settings.checking") : t("multica.settings.apply")}
						</Button>
						<Button size="sm" type="button" variant="ghost" disabled={busy} onClick={cancel}>
							{t("multica.settings.cancel")}
						</Button>
						{failure && failure !== "save" && failure.forceable ? (
							<Button size="sm" type="button" variant="outline" disabled={busy} onClick={() => void apply(true)}>
								{t("multica.settings.saveAnyway")}
							</Button>
						) : null}
					</div>
				</div>
			) : null}
			{failure ? (
				<p role="alert" className="px-3 pb-2 text-caption leading-4 text-error">
					{failure === "save" ? t("multica.settings.saveFailed") : t(errorKeys[failure.error])}
				</p>
			) : null}
			{signIn ? (
				<p className="px-3 pb-2 text-caption leading-4 text-muted-foreground">
					{t("multica.settings.cliSignIn")} <code className="select-text break-all">{signIn}</code>
				</p>
			) : null}
			{draft.mode === "local" ? <p className="px-3 pb-2 text-caption leading-4 text-muted-foreground">{t("multica.settings.selfHostNote")}</p> : null}
		</SettingsSection>
	);
}
