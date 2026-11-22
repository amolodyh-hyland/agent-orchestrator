import { useTranslation } from "react-i18next";
import { useUiStore } from "../../stores/ui-store";
import { SettingsOptionMenu } from "./SettingsOptionMenu";
import { SettingsRow } from "./SettingsRow";
import type { AddressDisplay } from "../../lib/chat-address";

export function AddressSettingsRows() {
	const { t } = useTranslation();
	const urlDisplay = useUiStore((state) => state.chatUrlDisplay);
	const pathDisplay = useUiStore((state) => state.chatPathDisplay);
	const setUrlDisplay = useUiStore((state) => state.setChatUrlDisplay);
	const setPathDisplay = useUiStore((state) => state.setChatPathDisplay);
	const options: { value: AddressDisplay; label: string }[] = [{ value: "full", label: t("settings.address.full") }, { value: "compact", label: t("settings.address.compact") }];
	return <>
		<SettingsRow label={t("settings.address.urls")} description={t("settings.address.hint")}>
			<SettingsOptionMenu aria-label={t("settings.address.urls")} options={options} value={urlDisplay} onChange={setUrlDisplay} />
		</SettingsRow>
		<SettingsRow label={t("settings.address.paths")}>
			<SettingsOptionMenu aria-label={t("settings.address.paths")} options={options} value={pathDisplay} onChange={setPathDisplay} />
		</SettingsRow>
	</>;
}
