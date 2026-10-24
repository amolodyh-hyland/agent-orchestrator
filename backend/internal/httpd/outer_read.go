package httpd

import (
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/outer"
)

type nativeOuterRead struct {
	Projection string `json:"projection"`
	ProjectID  string `json:"projectId,omitempty"`
	Kind       string `json:"kind,omitempty"`
	After      int64  `json:"after,omitempty"`
	Limit      int    `json:"limit,omitempty"`
	Nonce      string `json:"nonce"`
	Expires    int64  `json:"expires"`
}

// Passive desktop observation uses a separate private purpose. It issues no
// human request, native action or credential usable for a model turn.
func mountOuterRead(router chi.Router, svc *outer.Service, authority *delegationauth.Authority) {
	router.Post("/internal/outer/read", func(w http.ResponseWriter, req *http.Request) {
		reject := func() {
			_ = svc.Deny(req.Context(), "outer.desktop.read", "trusted_desktop_read_required", "")
			envelope.WriteAPIError(w, req, http.StatusConflict, "conflict", "OUTER_HELD", "Use the trusted desktop projection or a current outer credential", nil)
		}
		if !localControlRequest(req) || authority == nil {
			reject()
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, req.Body, 4<<10))
		if err != nil || !authority.AuthorizeOuterRead(raw, req.Header.Get("X-AO-Delegation-MAC")) {
			reject()
			return
		}
		var in nativeOuterRead
		if domain.StrictDelegationJSON(raw, &in) != nil || !authority.ConsumeRun(in.Nonce, in.Expires) {
			reject()
			return
		}
		ctx := domain.WithOuterNativeAction(req.Context(), domain.OuterNativeAction{Operation: "outer.read"})
		var value any
		switch in.Projection {
		case "view":
			if in.ProjectID != "" || in.Kind != "" || in.After != 0 || in.Limit != 0 {
				reject()
				return
			}
			value, err = svc.View(ctx)
		case "facts":
			if in.ProjectID == "" || (in.Kind != "reports" && in.Kind != "sessions" && in.Kind != "runs") || in.After != 0 || in.Limit < 1 || in.Limit > 50 {
				reject()
				return
			}
			var facts []domain.OuterFact
			facts, err = svc.Read(ctx, in.ProjectID, in.Kind, in.Limit)
			value = map[string]any{"facts": facts}
		case "audit":
			if in.ProjectID != "" || in.Kind != "" || in.After < 0 || in.Limit < 1 || in.Limit > 100 {
				reject()
				return
			}
			var events []domain.OuterAudit
			events, err = svc.Audit(ctx, in.After, in.Limit)
			value = map[string]any{"events": events}
		default:
			reject()
			return
		}
		if err != nil {
			reject()
			return
		}
		writeDelegationJournalResponse(w, req, authority, map[string]any{"projection": in.Projection, "data": value})
	})
}
