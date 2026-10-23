import type { ChatSkill, ChatSkillCatalog, ChatSkillSelection } from "../types/conversation";

export type ComposerSkillSelection = {
	selection: ChatSkillSelection;
	catalogIdentity?: string;
};

export function skillCatalogIdentity(catalog: ChatSkillCatalog, hostId?: string): string {
	return JSON.stringify([hostId ?? "local", catalog.resolverId, catalog.sessionId, catalog.projectRevision,
		catalog.snapshotId, catalog.providerId, catalog.adapterVersion, catalog.controllerGeneration,
		catalog.catalogRevision, catalog.trustEpoch]);
}

export function skillKey(skill: ChatSkill): string {
	return skill.bindingRef || skill.observationId || skill.entryId || skill.name;
}

export function skillToken(skill: ChatSkill): string {
	return skill.token || `/${skill.name}`;
}

export function skillSelectable(skill: ChatSkill): boolean {
	const legacy = skill.canInvoke === undefined && !skill.status && !skill.bindingRef && !skill.entryId && !skill.observationId;
	return legacy || (skill.canInvoke === true && Boolean(skill.token && skill.bindingRef && skill.catalogRevision && skill.controllerGeneration)
		&& ["ready", "native_passthrough"].includes(skill.status ?? "")
		&& ["native_text", "native_skill"].includes(skill.transport ?? ""));
}

export function selectSkill(skill: ChatSkill): ComposerSkillSelection | undefined {
	if (!skillSelectable(skill) || !skill.bindingRef || !skill.catalogRevision || !skill.controllerGeneration) return undefined;
	return { catalogIdentity: skill.catalogIdentity, selection: {
		bindingRef: skill.bindingRef, catalogRevision: skill.catalogRevision,
		controllerGeneration: skill.controllerGeneration, entryId: skill.entryId,
		snapshotId: skill.snapshotId, token: skillToken(skill),
	} };
}

export function selectedTokenPresent(text: string, token: string): boolean {
	return text.split(/\s+/).some((word) => word === token);
}

export function selectionIsCurrent(selected: ComposerSkillSelection, skills: readonly ChatSkill[]): boolean {
	return skills.some((skill) => skillSelectable(skill) && skill.bindingRef === selected.selection.bindingRef
		&& skill.entryId === selected.selection.entryId && skill.snapshotId === selected.selection.snapshotId
		&& skill.controllerGeneration === selected.selection.controllerGeneration
		&& skill.catalogRevision === selected.selection.catalogRevision && skillToken(skill) === selected.selection.token
		&& skill.catalogIdentity === selected.catalogIdentity);
}

export function isComposerSkillSelection(value: unknown): value is ComposerSkillSelection {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<ComposerSkillSelection>;
	const selection = item.selection;
	return Boolean(selection && typeof selection === "object"
		&& typeof selection.bindingRef === "string" && typeof selection.catalogRevision === "string"
		&& typeof selection.controllerGeneration === "string" && typeof selection.token === "string"
		&& (selection.entryId === undefined || typeof selection.entryId === "string")
		&& (selection.snapshotId === undefined || typeof selection.snapshotId === "string")
		&& (item.catalogIdentity === undefined || typeof item.catalogIdentity === "string"));
}
