import { randomBytes } from "node:crypto";

export function createDelegationConfirmationTokens(now: () => number) {
	const issued = new Map<string, { hash: string; expiresAt: number }>();
	return {
		mint(hash: string, previewExpiresAt: number): string {
			const token = randomBytes(32).toString("base64url");
			issued.set(token, { hash, expiresAt: Math.min(now() + 10_000, previewExpiresAt) });
			return token;
		},
		consume(token: string, hash: string): boolean {
			const approval = issued.get(token);
			issued.delete(token);
			return !!approval && approval.hash === hash && approval.expiresAt > now();
		},
		clear() { issued.clear(); },
	};
}
