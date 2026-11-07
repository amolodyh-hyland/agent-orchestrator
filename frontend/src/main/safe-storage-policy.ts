export function protectedStorageBackend(platform: NodeJS.Platform, backend?: string): boolean {
	return platform !== "linux" || ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(backend ?? "");
}

export function requireProtectedCiphertext(ciphertext: Buffer, platform: NodeJS.Platform): Buffer {
	if (platform === "linux" && !["v11", "v12"].includes(ciphertext.subarray(0, 3).toString("ascii"))) {
		throw new Error("Protected encryption provider unavailable");
	}
	return ciphertext;
}
