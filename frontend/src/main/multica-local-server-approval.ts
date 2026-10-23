import type { ProjectLogRequest } from "./multica-local-server";
import type { ProjectApproval, ProjectApprovalRequest } from "./multica-local-server-preflight";
import { verifyRecoveryReceipt } from "./multica-local-server-preflight";

type Dialogs = {
	show: (options: { type: "warning" | "error"; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: boolean }) => Promise<{ response: number }>;
	chooseReceipt: () => Promise<string | null>;
	verify?: typeof verifyRecoveryReceipt;
};

export async function approveLocalServerMutation(request: ProjectApprovalRequest, dialogs: Dialogs): Promise<ProjectApproval | null> {
	const inventory = JSON.stringify({ existing: request.snapshot, approvedPlan: request.plan }, null, 2);
	const selected = await dialogs.show({
		type: "warning", message: "Existing multica project: recovery required",
		detail: `Action: ${request.action}\nTarget: ${request.stackDir}\nSnapshot: ${request.digest}\n${inventory}\n\nThis includes stopped services and retained data. A different folder or port still targets this project. Preserve its protected Compose and environment files, exact images and data; test restoration in disposable state first. Select the private recovery receipt for this exact snapshot to continue.`,
		buttons: ["Cancel", "Select recovery receipt"], defaultId: 0, cancelId: 0, noLink: true,
	});
	if (selected.response !== 1) return null;
	const file = await dialogs.chooseReceipt();
	if (!file) return null;
	try {
		await (dialogs.verify ?? verifyRecoveryReceipt)(file, request.digest);
	} catch {
		await dialogs.show({ type: "error", message: "Recovery evidence could not be verified", detail: "Use a private receipt bound to this snapshot with preserved configuration, image archive, data backup, restore procedure and successful restore verification. Nothing was changed.", buttons: ["OK"], defaultId: 0, cancelId: 0, noLink: true });
		return null;
	}
	const approved = await dialogs.show({
		type: "warning", message: `Approve ${request.action}, takeover and downtime?`,
		detail: `Target: ${request.stackDir}\nSnapshot: ${request.digest}\n${inventory}\n\nRecovery receipt: ${file}\nI confirm this receipt preserves all listed services' protected configuration and exact image identities, backs up all necessary data, and records a restore procedure successfully tested in disposable state. I approve this one action's takeover and downtime for every listed service. No image build or pull is authorized. Other Docker clients do not honor the local control lock. If post-verification detects interference, affected containers will be stopped and reported; migrations and data changes cannot be undone automatically.`,
		buttons: ["Cancel", "Approve takeover and downtime"], defaultId: 0, cancelId: 0, noLink: true,
	});
	return approved.response === 1 ? { digest: request.digest, action: request.action, recoveryReceipt: file } : null;
}

export async function approveLocalServerLogs(request: ProjectLogRequest, dialogs: Pick<Dialogs, "show">): Promise<boolean> {
	const result = await dialogs.show({
		type: "warning", message: "Read local server logs?",
		detail: `Service: ${request.service}\nMaximum lines: ${request.tail}\nFolder: ${request.stackDir}\nSnapshot: ${request.digest}\n${JSON.stringify(request.snapshot, null, 2)}\n\nThese may be an existing project's logs and contain sign-in codes, credentials or private data. Approve only if you are authorized to read this project's logs.`,
		buttons: ["Cancel", "Read logs"], defaultId: 0, cancelId: 0, noLink: true,
	});
	return result.response === 1;
}
