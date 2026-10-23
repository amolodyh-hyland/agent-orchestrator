package httpd

import (
	"context"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/factoryrun"
)

type factoryRunConfirmation interface {
	Preview(context.Context, string, string) (factoryrun.ConfirmationPreview, error)
	Confirm(context.Context, string, string, int64, string) (domain.RunDetail, error)
}

// Only the inherited, boot-scoped desktop authority can enter this boundary.
// It is deliberately absent from public API, CLI, tools, and renderer bridges.
func mountFactoryRunConfirmation(r chi.Router, service controllers.FactoryRunService, authority *delegationauth.Authority) {
	svc, ok := service.(factoryRunConfirmation)
	if !ok {
		return
	}
	r.Post("/internal/factory-run-confirmation", func(w http.ResponseWriter, req *http.Request) {
		reject := func() {
			envelope.WriteJSON(w, http.StatusForbidden, map[string]string{"status": "confirmation_required"})
		}
		if !localControlRequest(req) || authority == nil {
			reject()
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, req.Body, 4096))
		proof := req.Header.Get("X-AO-Delegation-MAC")
		if err != nil || !authority.AuthorizeRun(raw, proof) {
			reject()
			return
		}
		var in struct {
			Operation       string `json:"operation"`
			RunID           string `json:"runId"`
			Action          string `json:"action"`
			ExpectedVersion int64  `json:"expectedVersion"`
			Digest          string `json:"digest"`
			Nonce           string `json:"nonce"`
			Expires         int64  `json:"expires"`
		}
		if domain.StrictDelegationJSON(raw, &in) != nil || !authority.ConsumeRun(in.Nonce, in.Expires) {
			reject()
			return
		}
		var value any
		switch in.Operation {
		case "preview":
			value, err = svc.Preview(req.Context(), in.RunID, in.Action)
		case "confirm":
			// The existing exact evidence confirmation retains its own authority.
			// It does not become an outer Send or cross-project action grant.
			detail, readErr := service.Get(req.Context(), in.RunID)
			if readErr != nil {
				err = readErr
				break
			}
			ctx := domain.WithOuterNativeAction(req.Context(), domain.OuterNativeAction{Operation: "run.confirm", ProjectID: domain.ProjectID(detail.Run.ProjectID), SessionID: detail.Run.SessionID})
			value, err = svc.Confirm(ctx, in.RunID, in.Action, in.ExpectedVersion, in.Digest)
		default:
			reject()
			return
		}
		if err != nil {
			envelope.WriteError(w, req, err)
			return
		}
		writeDelegationJournalResponse(w, req, authority, value)
	})
}
