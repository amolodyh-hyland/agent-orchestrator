//go:build windows

package agentcreds

import (
	"context"
	"errors"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func protectedPolicyOwner(path string, _ os.FileInfo) bool {
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false
	}
	return safePolicyDescriptor(descriptor)
}

func safePolicyDescriptor(descriptor *windows.SECURITY_DESCRIPTOR) bool {
	owner, _, err := descriptor.Owner()
	if err != nil || !policySystemSID(owner) {
		return false
	}
	acl, _, err := descriptor.DACL()
	if err != nil || acl == nil {
		return false
	}
	const policyFileDeleteChild = 0x40
	const writes = windows.GENERIC_WRITE | windows.GENERIC_ALL | windows.WRITE_DAC | windows.WRITE_OWNER | windows.DELETE | windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA | windows.FILE_WRITE_EA | windows.FILE_WRITE_ATTRIBUTES | policyFileDeleteChild
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var raw *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, i, &raw) != nil || raw == nil {
			return false
		}
		header := (*windows.ACE_HEADER)(unsafe.Pointer(raw))
		if header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
			continue
		}
		if header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return false
		}
		ace := raw
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if ace.Mask&writes != 0 && !policySystemSID(sid) {
			return false
		}
	}
	return true
}

func policySystemSID(sid *windows.SID) bool {
	return sid != nil && (sid.IsWellKnown(windows.WinLocalSystemSid) || sid.IsWellKnown(windows.WinBuiltinAdministratorsSid) || sid.String() == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464")
}

func openProtectedPolicyFile(path string) (*os.File, error) { return os.Open(path) }

func protectedPolicyMode(os.FileInfo) bool { return true }

func protectedDelegationRegistry(ctx context.Context) ([]claudePolicyDocument, bool) {
	exists := false
	for _, path := range []string{`MACHINE\SOFTWARE\Policies\ClaudeCode`, `MACHINE\SOFTWARE\Policies`, `MACHINE\SOFTWARE`, `MACHINE`} {
		descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_REGISTRY_KEY, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			continue
		}
		if err != nil || !safePolicyDescriptor(descriptor) {
			return []claudePolicyDocument{{broken: true}}, true
		}
		if strings.HasSuffix(path, `\ClaudeCode`) {
			exists = true
		}
	}
	if !exists {
		return nil, false
	}
	value, err := readClaudeRegistryValue(ctx, "HKLM")
	if err != nil || value.expandable && strings.Contains(string(value.data), "%") {
		return []claudePolicyDocument{{broken: true}}, true
	}
	return []claudePolicyDocument{parseClaudePolicyDocument(value.data)}, true
}
