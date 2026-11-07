import { expect, it } from "vitest";
import { protectedStorageBackend, requireProtectedCiphertext } from "./safe-storage-policy";

it("refuses unknown and plaintext Linux providers even when availability is true", () => {
	for (const backend of [undefined, "basic_text", "unknown", "future-unverified-provider"]) expect(protectedStorageBackend("linux", backend)).toBe(false);
	for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) expect(protectedStorageBackend("linux", backend)).toBe(true);
});

it("rejects async Linux fallback output and accepts only known protected encryption tags", () => {
	for (const prefix of ["v10", "", "raw", "v99"]) expect(() => requireProtectedCiphertext(Buffer.from(prefix + "fixture"), "linux")).toThrow();
	for (const prefix of ["v11", "v12"]) expect(requireProtectedCiphertext(Buffer.from(prefix + "fixture"), "linux").toString()).toBe(prefix + "fixture");
	expect(requireProtectedCiphertext(Buffer.from("v10-mac-keychain-fixture"), "darwin").toString()).toBe("v10-mac-keychain-fixture");
});
