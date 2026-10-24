import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
	desktopConfirmations,
	desktopConfirmationPreview,
	desktopControlReceipt,
	subscribeDesktopConfirmations,
} from "../lib/outer-desktop-confirmation";
import { OuterNativeButton } from "./OuterNativeButton";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "./ui/dialog";

// Existing forms can finish asynchronous preparation before requesting this
// second, exact gesture. A scripted click can open inert data, but cannot
// confirm it; only the isolated preload can spend the displayed stage.
export function DesktopActionConfirmation() {
	const { t } = useTranslation();
	const [entry] = useSyncExternalStore(
		subscribeDesktopConfirmations,
		desktopConfirmations
	);
	if (!entry) return null;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) entry.finish();
			}}
		>
			<DialogContent className="z-overlay max-h-[80vh] overflow-y-auto">
				<DialogTitle>{t("outer.desktopConfirmTitle")}</DialogTitle>
				<DialogDescription>
					{t("outer.desktopConfirmDescription")}
				</DialogDescription>
				<pre className="whitespace-pre-wrap break-all text-xs">
					{desktopConfirmationPreview(
						entry.request,
						t("outer.privateValue")
					)}
				</pre>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => entry.finish()}
					>
						{t("confirm.cancel")}
					</Button>
					<OuterNativeButton
						key={entry.id}
						draft={{
							operation: "control",
							control: {
								action: "desktop.control",
								targetId: "",
								body: entry.request,
							},
						}}
						onResult={(result) =>
							entry.finish(desktopControlReceipt(result))
						}
					>
						{t("outer.desktopConfirm")}
					</OuterNativeButton>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
