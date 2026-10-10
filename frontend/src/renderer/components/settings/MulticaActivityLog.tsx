import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MULTICA_ACTION_KINDS, type MulticaActionKind, type MulticaActionRecord } from "../../../shared/multica-action-log";
import { aoBridge } from "../../lib/bridge";
import { Button } from "../ui/button";

/**
 * Read-only table of the action log (actions and decisions only), newest first,
 * filtered by kind, exportable as JSON. It never offers an action.
 */
export function MulticaActivityLog() {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<MulticaActionKind | "">("");
	const [records, setRecords] = useState<MulticaActionRecord[] | null>(null);

	const load = async (nextKind: MulticaActionKind | "") => {
		try {
			setRecords(await aoBridge.multicaActionLog.read(nextKind ? { kind: nextKind } : undefined));
		} catch {
			setRecords([]);
		}
	};

	const exportJson = () => {
		const blob = new Blob([JSON.stringify(records ?? [], null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = "multica-activity.json";
		link.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="flex flex-col gap-2 px-3 pb-3">
			<div className="flex items-center gap-2">
				<span className="text-xs font-medium text-muted-foreground">{t("multica.awareness.activity.title")}</span>
				<Button
					size="sm"
					type="button"
					variant="ghost"
					aria-expanded={open}
					onClick={() => {
						const next = !open;
						setOpen(next);
						if (next) void load(kind);
					}}
				>
					{open ? t("multica.awareness.activity.hide") : t("multica.awareness.activity.show")}
				</Button>
			</div>
			{open ? (
				<div className="flex flex-col gap-2" data-testid="multica-activity-log">
					<div className="flex items-center gap-2 text-xs">
						<select
							className="rounded border border-border bg-background px-1 py-0.5"
							aria-label={t("multica.awareness.activity.kind")}
							value={kind}
							onChange={(event) => {
								const next = event.target.value as MulticaActionKind | "";
								setKind(next);
								void load(next);
							}}
						>
							<option value="">{t("multica.awareness.who.all")}</option>
							{MULTICA_ACTION_KINDS.map((value) => (
								<option key={value} value={value}>
									{value}
								</option>
							))}
						</select>
						<Button size="sm" type="button" variant="outline" disabled={!records || records.length === 0} onClick={exportJson}>
							{t("multica.awareness.activity.export")}
						</Button>
					</div>
					{records && records.length === 0 ? <p className="text-caption leading-4 text-muted-foreground">{t("multica.awareness.activity.empty")}</p> : null}
					{records && records.length > 0 ? (
						<table className="w-full text-left text-caption">
							<thead className="text-muted-foreground">
								<tr>
									<th className="pr-2 font-medium">{t("multica.awareness.activity.time")}</th>
									<th className="pr-2 font-medium">{t("multica.awareness.activity.issue")}</th>
									<th className="pr-2 font-medium">{t("multica.awareness.activity.kind")}</th>
									<th className="pr-2 font-medium">{t("multica.awareness.activity.actor")}</th>
									<th className="font-medium">{t("multica.awareness.activity.result")}</th>
								</tr>
							</thead>
							<tbody>
								{records.map((record) => (
									<tr key={record.id} className="border-t border-border align-top">
										<td className="pr-2">{record.ts}</td>
										<td className="pr-2">{record.identifier ?? ""}</td>
										<td className="pr-2">{record.kind}</td>
										<td className="pr-2">{record.actor}</td>
										<td>{record.result ? (record.result.ok ? t("multica.awareness.activity.ok") : (record.result.code ?? t("multica.awareness.activity.error"))) : ""}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : null}
				</div>
			) : null}
		</div>
	);
}
