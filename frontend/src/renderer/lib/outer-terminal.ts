// Runtime-specific native grants stay in memory. They cannot authenticate as
// project CLI credentials and are never persisted or carried across reloads.
const grants = new Map<string, string>();
export function outerTerminalAuthority(handle: string): string | undefined { return grants.get(handle); }
export function setOuterTerminalAuthority(handle: string, authority: string) {
	grants.set(handle, authority);
	window.dispatchEvent(new CustomEvent("ao:terminal-authority", { detail: handle }));
}
