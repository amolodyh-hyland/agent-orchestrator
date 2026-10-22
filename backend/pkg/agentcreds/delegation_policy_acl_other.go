//go:build !darwin && !windows

package agentcreds

func protectedPolicyACL(string) bool { return true }
