package codexappserver

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Asserted here so a refactor cannot silently drop skill listing: the service
// feature-detects this interface, and a missed method would read to a client as
// "this agent has no skills" with nothing to notice.
var _ ports.ChatSkillLister = (*conversation)(nil)

// skillsListResponse is the subset of `skills/list` AO reads.
//
// The provider groups results by working directory because a client may ask about
// several at once. AO asks about one, so the groups are flattened.
type skillsListResponse struct {
	Data []struct {
		Cwd    string            `json:"cwd"`
		Errors []json.RawMessage `json:"errors"`
		Skills []struct {
			Name string `json:"name"`
			Path string `json:"path"`
			// Description is the full trigger text from SKILL.md. It is written for
			// the model, not for a menu, and routinely runs to a paragraph.
			Description string `json:"description"`
			// ShortDescription is the legacy SKILL.md field; SKILL.json's
			// interface.shortDescription supersedes it when both are present.
			ShortDescription string `json:"shortDescription"`
			Enabled          bool   `json:"enabled"`
			// Scope is where the skill came from: user, repo, system, admin.
			Scope     string `json:"scope"`
			Interface *struct {
				DisplayName      string `json:"displayName"`
				ShortDescription string `json:"shortDescription"`
			} `json:"interface"`
		} `json:"skills"`
	} `json:"data"`
}

// ListSkills preserves enabled native entries and their backend path identities.
func (c *conversation) ListSkills(ctx context.Context) ([]ports.ChatSkill, error) {
	return c.listSkills(ctx, false)
}

// ReloadSkills requests a native same-snapshot catalog refresh.
func (c *conversation) ReloadSkills(ctx context.Context) ([]ports.ChatSkill, error) {
	return c.listSkills(ctx, true)
}

func (c *conversation) listSkills(ctx context.Context, reload bool) ([]ports.ChatSkill, error) {
	var resp skillsListResponse
	params := map[string]any{"cwds": []string{c.workdir}, "forceReload": reload}
	if err := c.conn.request(ctx, "skills/list", params, &resp); err != nil {
		return nil, fmt.Errorf("skills/list: %w", err)
	}
	if resp.Data == nil {
		return nil, ports.ErrChatSkillsNotReady
	}
	skills := make([]ports.ChatSkill, 0)

	seen := make(map[string]bool)
	for _, group := range resp.Data {
		if len(group.Errors) > 0 {
			return nil, ports.ErrChatSkillsNotReady
		}
		for _, entry := range group.Skills {
			if entry.Name == "" || !entry.Enabled {
				continue
			}
			key := entry.Name + "\x00" + entry.Path + "\x00" + entry.Scope
			if seen[key] {
				continue
			}
			seen[key] = true

			display := entry.Name
			description := entry.Description
			if entry.ShortDescription != "" {
				description = entry.ShortDescription
			}
			if entry.Interface != nil {
				if entry.Interface.DisplayName != "" {
					display = entry.Interface.DisplayName
				}
				// Preferred over the legacy field per the provider's own note on
				// shortDescription.
				if entry.Interface.ShortDescription != "" {
					description = entry.Interface.ShortDescription
				}
			}

			reason := ""
			if entry.Path == "" {
				reason = "native_path_unavailable"
			}
			skills = append(skills, ports.ChatSkill{
				Name:          entry.Name,
				DisplayName:   display,
				Description:   description,
				Source:        entry.Scope,
				NativePath:    entry.Path,
				ObservationID: fmt.Sprintf("native_%x", sha256.Sum256([]byte(key))),
				TrustState:    "native_unverified", Status: "native_passthrough",
				Transport: "native_skill", Token: "$" + entry.Name,
				CanInvoke: entry.Path != "", ReasonCode: reason,
			})
		}
	}
	return skills, nil
}
