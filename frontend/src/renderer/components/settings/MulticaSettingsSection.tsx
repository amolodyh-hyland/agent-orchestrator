import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseMulticaUrl } from "../../../shared/multica";
import { aoBridge } from "../../lib/bridge";
import { SettingsInputRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function MulticaSettingsSection() {
	const { t } = useTranslation();
	const [value, setValue] = useState("");
	const [saved, setSaved] = useState("");
	const [error, setError] = useState<"invalid" | "save" | null>(null);

	useEffect(() => {
		let cancelled = false;
		aoBridge.multica
			.getSettings()
			.then((settings) => {
				if (cancelled) return;
				setValue(settings.url);
				setSaved(settings.url);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	const commit = async (next: string) => {
		const url = next.trim();
		if (url === saved) {
			setValue(saved);
			setError(null);
			return;
		}
		// An empty value is allowed: it turns the Multica view off.
		if (url !== "" && !parseMulticaUrl(url).ok) {
			setError("invalid");
			return;
		}
		try {
			const settings = await aoBridge.multica.setSettings(url);
			setValue(settings.url);
			setSaved(settings.url);
			setError(null);
		} catch {
			setError("save");
		}
	};

	return (
		<SettingsSection title={t("multica.title")} grouped>
			<SettingsInputRow
				id="multica-url"
				label={t("multica.settings.url")}
				value={value}
				onChange={setValue}
				onCommit={(url) => void commit(url)}
				onCancel={() => {
					setValue(saved);
					setError(null);
				}}
				placeholder={t("multica.settings.notSet")}
			/>
			{error ? (
				<p role="alert" className="px-3 text-caption leading-4 text-error">
					{error === "invalid" ? t("multica.settings.invalidUrl") : t("multica.settings.saveFailed")}
				</p>
			) : null}
		</SettingsSection>
	);
}
