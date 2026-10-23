package controllers

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
)

type conversationSkillCatalogService interface {
	SkillCatalog(context.Context, domain.SessionID, bool, string) (ports.ChatSkillCatalog, error)
}

func (c *ConversationsController) skills(w http.ResponseWriter, r *http.Request) {
	c.serveSkillCatalog(w, r, false, "")
}

func (c *ConversationsController) refreshSkills(w http.ResponseWriter, r *http.Request) {
	var req RefreshConversationSkillsRequest
	if !decodeConversationBody(w, r, &req) {
		return
	}
	c.serveSkillCatalog(w, r, true, req.SnapshotID)
}

func (c *ConversationsController) serveSkillCatalog(w http.ResponseWriter, r *http.Request, reload bool, snapshot string) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, r.Method, "/api/v1/sessions/{sessionId}/conversation/skills")
		return
	}
	id := domain.SessionID(chi.URLParam(r, "sessionId"))
	if svc, ok := c.Svc.(conversationSkillCatalogService); ok {
		catalog, err := svc.SkillCatalog(r.Context(), id, reload, snapshot)
		if err != nil {
			writeConversationError(w, r, err)
			return
		}
		out := conversationSkillsResponse(catalog.Skills)
		out.Status = catalog.Status
		out.ReasonCode = catalog.ReasonCode
		out.SessionID = string(catalog.SessionID)
		out.SnapshotID = catalog.SnapshotID
		out.ControllerGeneration = catalog.ControllerGeneration
		out.CatalogRevision = catalog.CatalogRevision
		out.ProviderID = catalog.ProviderID
		out.AdapterVersion = catalog.AdapterVersion
		out.ResolverID = catalog.ResolverID
		out.ProjectRevision = catalog.ProjectRevision
		out.TrustEpoch = catalog.TrustEpoch
		out.CanList = catalog.CanList
		out.CanReloadSameSnapshot = catalog.CanReloadSameSnapshot
		out.PendingSelectionID = catalog.PendingSelectionID
		out.NextAction = catalog.NextAction
		envelope.WriteJSON(w, http.StatusOK, out)
		return
	}
	if reload {
		envelope.WriteJSON(w, http.StatusOK, ConversationSkillsResponse{Skills: []ConversationSkillResponse{}, Status: "unsupported_provider", ReasonCode: "reload_unsupported"})
		return
	}
	skills, err := c.Svc.Skills(r.Context(), id)
	if errors.Is(err, chatsvc.ErrSkillsUnsupported) {
		envelope.WriteJSON(w, http.StatusOK, ConversationSkillsResponse{Skills: []ConversationSkillResponse{}, Status: "unsupported_provider", ReasonCode: "listing_unsupported"})
		return
	}
	if err != nil {
		writeConversationError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, conversationSkillsResponse(skills))
}

func conversationSkillsResponse(skills []ports.ChatSkill) ConversationSkillsResponse {
	out := ConversationSkillsResponse{
		Skills: make([]ConversationSkillResponse, 0, len(skills)), Status: "ready",
	}
	for _, skill := range skills {
		display := skill.DisplayName
		if display == "" {
			// A skill with no label still has to render, and its own name is the
			// honest fallback.
			display = skill.Name
		}
		out.Skills = append(out.Skills, ConversationSkillResponse{
			Kind: skill.Kind, Format: skill.Format, Scope: skill.Scope,
			Name:          skill.Name,
			DisplayName:   display,
			Description:   skill.Description,
			InputHint:     skill.InputHint,
			Source:        skill.Source,
			ObservationID: skill.ObservationID, EntryID: skill.EntryID, SourceID: skill.SourceID, SnapshotID: skill.SnapshotID, ContentHash: skill.ContentHash,
			ControllerGeneration: skill.ControllerGeneration, CatalogRevision: skill.CatalogRevision, BindingRef: skill.BindingRef,
			TrustState: skill.TrustState, Status: skill.Status, ReasonCode: skill.ReasonCode, Transport: skill.Transport, Token: skill.Token, CanInvoke: skill.CanInvoke,
		})
	}
	return out
}
