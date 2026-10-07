export const PROJECT_COLOR_HUES = [20, 56, 92, 128, 164, 200, 236, 272, 308, 344] as const;

export const PROJECT_COLOR_SLOTS = PROJECT_COLOR_HUES.length;

export function fnv1a32(text: string): number {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(text)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export function preferredProjectColorSlot(projectId: string): number {
	return fnv1a32(projectId) % PROJECT_COLOR_SLOTS;
}

export function assignProjectColorSlot(projectId: string, taken: ReadonlySet<number>): number {
	const preferred = preferredProjectColorSlot(projectId);
	for (let offset = 0; offset < PROJECT_COLOR_SLOTS; offset += 1) {
		const slot = (preferred + offset) % PROJECT_COLOR_SLOTS;
		if (!taken.has(slot)) return slot;
	}
	return preferred;
}

export function projectColorCss(slot: number, theme: "light" | "dark"): string {
	const hue = PROJECT_COLOR_HUES[((slot % PROJECT_COLOR_SLOTS) + PROJECT_COLOR_SLOTS) % PROJECT_COLOR_SLOTS];
	return theme === "dark" ? `oklch(0.74 0.14 ${hue})` : `oklch(0.56 0.15 ${hue})`;
}
