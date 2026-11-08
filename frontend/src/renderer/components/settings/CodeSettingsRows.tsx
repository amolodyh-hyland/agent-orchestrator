import { useTranslation } from "react-i18next";
import { CODE_LANGUAGES } from "../../lib/code-highlight";
import { THEMES } from "../../lib/theme-palettes";
import type { CodeColorTheme, CodeLanguage } from "../../lib/code-style";
import { useUiStore } from "../../stores/ui-store";
import { SettingsOptionMenu, type SettingsOption } from "./SettingsOptionMenu";
import { SettingsRow } from "./SettingsRow";

export function CodeSettingsRows() {
	const { t } = useTranslation();
	const blockLanguage = useUiStore((state) => state.defaultCodeBlockLanguage);
	const inlineLanguage = useUiStore((state) => state.defaultInlineCodeLanguage);
	const colorTheme = useUiStore((state) => state.codeColorTheme);
	const setBlockLanguage = useUiStore((state) => state.setDefaultCodeBlockLanguage);
	const setInlineLanguage = useUiStore((state) => state.setDefaultInlineCodeLanguage);
	const setColorTheme = useUiStore((state) => state.setCodeColorTheme);
	const languages: SettingsOption<CodeLanguage>[] = [
		{ value: "none", label: t("settings.code.none") },
		...CODE_LANGUAGES.map((value) => ({ value, label: value })),
	];
	const themes: SettingsOption<CodeColorTheme>[] = [
		{ value: "app", label: t("settings.code.followApp") },
		...THEMES.map(({ id, label }) => ({ value: id, label })),
	];
	return <>
		<SettingsRow label={t("settings.code.blockLanguage")} description={t("settings.code.blockLanguageHint")}>
			<SettingsOptionMenu aria-label={t("settings.code.blockLanguage")} value={blockLanguage} options={languages} onChange={setBlockLanguage} searchable />
		</SettingsRow>
		<SettingsRow label={t("settings.code.inlineLanguage")}>
			<SettingsOptionMenu aria-label={t("settings.code.inlineLanguage")} value={inlineLanguage} options={languages} onChange={setInlineLanguage} searchable />
		</SettingsRow>
		<SettingsRow label={t("settings.code.colorTheme")} description={t("settings.code.colorThemeHint")}>
			<SettingsOptionMenu aria-label={t("settings.code.colorTheme")} value={colorTheme} options={themes} onChange={setColorTheme} searchable />
		</SettingsRow>
	</>;
}
