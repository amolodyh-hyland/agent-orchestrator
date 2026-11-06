import { expect, it, vi } from "vitest";
import { parseProcessIdentity, processIdentityQuery, readDaemonProcessIdentity, type ProcessIdentityQuery } from "./daemon-process-identity";

it("uses native Windows process creation FILETIME without Unix ps or profiles", async () => {
	const execute = vi.fn(async (query: ProcessIdentityQuery) => {
		expect(query.command).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/);
		expect(query.args).toContain("-NoProfile");
		expect(query.args).toContain("-NonInteractive");
		expect(query.args.at(-1)).toContain("Get-Process -Id 123");
		expect(query.args.at(-1)).toContain("ToFileTimeUtc");
		return JSON.stringify({ processStart: "windows-filetime:134121123456789123", executable: "C:\\AO\\ao.exe" });
	});
	expect(await readDaemonProcessIdentity(123, "win32", execute)).toEqual({ processStart: "windows-filetime:134121123456789123", executable: "C:\\AO\\ao.exe" });
});

it("fails closed when Windows identity is missing, malformed, or unavailable", async () => {
	for (const value of ["", "null", "{}", '{"processStart":134121123456789123}', '{"processStart":"windows-filetime:0","executable":"C:\\\\AO\\\\ao.exe"}', '{"processStart":"windows-filetime:134121123456789123"}']) {
		expect(parseProcessIdentity(value, "win32")).toBeNull();
	}
	expect(await readDaemonProcessIdentity(123, "win32", async () => { throw new Error("query denied"); })).toBeNull();
});

it("normalizes POSIX identities and rejects invalid query PIDs", () => {
	expect(parseProcessIdentity("Mon  Nov  9 00:00:00 2026\n", "darwin")).toEqual({ processStart: "Mon Nov 9 00:00:00 2026" });
	expect(processIdentityQuery(123, "linux").command).toBe("ps");
	for (const pid of [0, 1, -1, 1.5, Number.NaN]) expect(() => processIdentityQuery(pid, "win32")).toThrow();
});
