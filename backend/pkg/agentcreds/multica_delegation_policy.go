package agentcreds

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// DelegationPolicyRequest carries identifiers only, never task text or credentials.
type DelegationPolicyRequest struct {
	ServerOrigin string   `json:"serverOrigin"`
	WorkspaceID  string   `json:"workspaceId"`
	ProfileID    string   `json:"profileId"`
	RuntimeID    string   `json:"runtimeId"`
	RuntimeClass string   `json:"runtimeClass"`
	DataScopes   []string `json:"dataScopes"`
	Action       string   `json:"action"`
}

// DelegationPolicyDecision is the entire safe projection across process boundaries.
type DelegationPolicyDecision struct {
	Code string `json:"code"`
}

type managedDelegationPolicy struct {
	Version        int      `json:"version"`
	Revision       string   `json:"revision"`
	ValidUntil     string   `json:"validUntil"`
	Effect         string   `json:"effect"`
	ServerOrigins  []string `json:"serverOrigins"`
	WorkspaceIDs   []string `json:"workspaceIds"`
	ProfileIDs     []string `json:"profileIds"`
	RuntimeClasses []string `json:"runtimeClasses"`
	DataScopes     []string `json:"dataScopes"`
	Actions        []string `json:"actions"`
}

// ResolveManagedDelegationPolicy reuses AO's managed-settings reader without
// loading user/project settings, credentials, or executing policy helpers.
// Every configured delegation ceiling applies; no source can widen another.
func ResolveManagedDelegationPolicy(ctx context.Context, req DelegationPolicyRequest, opts ResolveOptions, now func() time.Time) DelegationPolicyDecision {
	return resolveManagedDelegationPolicy(ctx, req, opts, now, nativeDelegationPolicyFiles())
}

func resolveManagedDelegationPolicy(ctx context.Context, req DelegationPolicyRequest, opts ResolveOptions, now func() time.Time, fs delegationPolicyFiles) DelegationPolicyDecision {
	if now == nil {
		now = time.Now
	}
	result := func(code string) DelegationPolicyDecision { return DelegationPolicyDecision{Code: code} }
	dir, err := claudeConfigDir(opts)
	if err != nil || ctx.Err() != nil {
		return result("policy_unavailable")
	}
	sources, enrolled, sourceFailure := delegationProtectedSources(ctx, opts, fs)
	if sourceFailure != "" {
		return result(sourceFailure)
	}
	protectedPolicies := 0
	for _, source := range sources {
		protectedPolicies += len(source.delegationPolicies)
	}
	if enrolled && protectedPolicies == 0 {
		return result("policy_unavailable")
	}
	// A cache can only intersect the protected decision; it never proves enrollment
	// absent or supplies the policy required by a protected enrollment marker.
	cached := readClaudePolicyDocument(ctx, filepath.Join(dir, "remote-settings.json"))
	if !cached.empty {
		sources = append(sources, cached)
	}
	var firstExpiry time.Time
	code := "policy_absent"
	if enrolled {
		code = "policy_allowed"
	}
	for _, source := range sources {
		if source.broken || source.empty || source.dynamic || ctx.Err() != nil {
			return result("policy_unavailable")
		}
		for _, raw := range source.delegationPolicies {
			var p managedDelegationPolicy
			if decodeManagedDelegationPolicy(raw, &p) != nil || p.Version != 1 || strings.TrimSpace(p.Revision) == "" {
				return result("policy_unavailable")
			}
			expires, err := time.Parse(time.RFC3339Nano, p.ValidUntil)
			if err != nil || !now().Before(expires) {
				return result("policy_unavailable")
			}
			if firstExpiry.IsZero() || expires.Before(firstExpiry) {
				firstExpiry = expires
			}
			if p.Effect == "deny" {
				code = "policy_denied"
				continue
			}
			if p.Effect != "allow" || p.ServerOrigins == nil || p.WorkspaceIDs == nil || p.ProfileIDs == nil || p.RuntimeClasses == nil || p.DataScopes == nil || p.Actions == nil {
				return result("policy_unavailable")
			}
			origin, err := url.Parse(req.ServerOrigin)
			if err != nil || origin.Scheme != "http" && origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || req.WorkspaceID == "" || req.ProfileID == "" || req.RuntimeID == "" || req.Action != "delegate" || len(req.DataScopes) != 1 || req.DataScopes[0] != "task_brief" {
				return result("policy_unavailable")
			}
			if req.RuntimeClass != "local" && req.RuntimeClass != "remote" {
				return result("policy_runtime_unknown")
			}
			if !slices.Contains(p.ServerOrigins, req.ServerOrigin) || !slices.Contains(p.WorkspaceIDs, req.WorkspaceID) || !slices.Contains(p.ProfileIDs, req.ProfileID) || !slices.Contains(p.RuntimeClasses, req.RuntimeClass) || !slices.Contains(p.Actions, req.Action) || !slices.Contains(p.DataScopes, "task_brief") {
				code = "policy_denied"
			}
		}
	}
	if !firstExpiry.IsZero() && !now().Before(firstExpiry) {
		return result("policy_unavailable")
	}
	return result(code)
}

func decodeManagedDelegationPolicy(raw []byte, policy *managedDelegationPolicy) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return errors.New("invalid policy")
	}
	seen := make(map[string]bool)
	for decoder.More() {
		key, err := decoder.Token()
		name, ok := key.(string)
		if err != nil || !ok || seen[name] || !slices.Contains([]string{"version", "revision", "validUntil", "effect", "serverOrigins", "workspaceIds", "profileIds", "runtimeClasses", "dataScopes", "actions"}, name) {
			return errors.New("invalid policy")
		}
		seen[name] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return errors.New("invalid policy")
		}
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(policy); err != nil {
		return err
	}
	if !errors.Is(decoder.Decode(new(any)), io.EOF) {
		return errors.New("invalid policy")
	}
	return nil
}
