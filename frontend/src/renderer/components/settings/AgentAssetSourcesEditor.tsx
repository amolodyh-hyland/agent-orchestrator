import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

export function AgentAssetSourcesEditor({ value, onChange, project = false, disabled = false }: {
	value: string[] | null;
	onChange: (value: string[] | null) => void;
	project?: boolean;
	disabled?: boolean;
}) {
	const { t } = useTranslation();
	const id = useId();
	return <div className="flex flex-col gap-3 px-(--settings-row-inset) py-3">
		{project && <div className="flex items-center justify-between gap-3">
			<Label htmlFor={`${id}-inherit`}>{t("settings.agentAssetSources.inherit")}</Label>
			<Switch id={`${id}-inherit`} checked={value === null} disabled={disabled} onCheckedChange={(inherit) => onChange(inherit ? null : [])} />
		</div>}
		<Label htmlFor={id}>{t("settings.agentAssetSources.directories")}</Label>
		<textarea id={id} className="settings-field-control min-h-24 w-full px-4 py-3 text-sm" disabled={disabled || value === null} value={(value ?? []).join("\n")} placeholder="/path/to/workspace" onChange={(event) => onChange(event.target.value.split("\n"))} onBlur={(event) => onChange(event.target.value.split("\n").map((line) => line.trim()).filter(Boolean))} />
		<p className="text-sm text-settings-muted">{t("settings.agentAssetSources.description")}</p>
		<p className="text-sm text-settings-muted">{t("settings.agentAssetSources.support")}</p>
		<p className="text-sm text-settings-muted">{t("settings.agentAssetSources.liveEdits")}</p>
	</div>;
}
