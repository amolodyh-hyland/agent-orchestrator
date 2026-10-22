//go:build darwin && !cgo

package agentcreds

func protectedPolicyACL(string) bool { return false }
