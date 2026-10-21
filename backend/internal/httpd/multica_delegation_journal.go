package httpd

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// MulticaDelegationJournal is the daemon-owned durable dispatch boundary.
type MulticaDelegationJournal interface {
	GetMulticaDelegation(context.Context, string) (domain.MulticaDelegationRecord, error)
	FindMulticaDelegation(context.Context, string, string) (domain.MulticaDelegationRecord, error)
	ReserveMulticaDelegation(context.Context, domain.MulticaDelegationRecord) (domain.MulticaDelegationRecord, error)
	SaveMulticaDelegation(context.Context, domain.MulticaDelegationRecord) (domain.MulticaDelegationRecord, error)
}

func mountMulticaDelegationJournal(r chi.Router, journal MulticaDelegationJournal, authority *delegationauth.Authority) {
	if journal == nil {
		return
	}
	r.Post("/internal/multica-delegation-journal", func(w http.ResponseWriter, req *http.Request) {
		if !localControlRequest(req) || authority == nil {
			envelope.WriteJSON(w, http.StatusForbidden, map[string]string{"status": "forbidden"})
			return
		}
		raw, readErr := io.ReadAll(http.MaxBytesReader(w, req.Body, 100000))
		if readErr != nil || !authority.Authorize(raw, req.Header.Get("X-AO-Delegation-MAC")) {
			envelope.WriteJSON(w, http.StatusForbidden, map[string]string{"status": "forbidden"})
			return
		}
		var body struct {
			RequestNonce      string                         `json:"requestNonce"`
			Operation         string                         `json:"operation"`
			RequestID         string                         `json:"requestId"`
			ProjectID         string                         `json:"projectId"`
			TaskID            string                         `json:"taskId"`
			Record            domain.MulticaDelegationRecord `json:"record"`
			ConfirmationProof string                         `json:"confirmationProof,omitempty"`
		}
		if domain.StrictDelegationJSON(raw, &body) != nil || body.RequestNonce == "" {
			envelope.WriteJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid_request"})
			return
		}
		if body.Operation == "reserve" && !authority.Confirm(body.Record, body.ConfirmationProof) {
			envelope.WriteJSON(w, http.StatusForbidden, map[string]string{"status": "confirmation_required"})
			return
		}
		var record domain.MulticaDelegationRecord
		var err error
		switch body.Operation {
		case "get":
			record, err = journal.GetMulticaDelegation(req.Context(), body.RequestID)
		case "find":
			record, err = journal.FindMulticaDelegation(req.Context(), body.ProjectID, body.TaskID)
		case "reserve":
			record, err = journal.ReserveMulticaDelegation(req.Context(), body.Record)
		case "save":
			record, err = journal.SaveMulticaDelegation(req.Context(), body.Record)
		default:
			err = domain.ErrDelegationInvalid
		}
		if errors.Is(err, sql.ErrNoRows) && (body.Operation == "get" || body.Operation == "find") {
			writeDelegationJournalResponse(w, req, authority, nil)
			return
		}
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, domain.ErrDelegationConflict) {
				status = http.StatusConflict
			}
			if errors.Is(err, domain.ErrDelegationInvalid) {
				status = http.StatusBadRequest
			}
			envelope.WriteJSON(w, status, map[string]string{"status": "journal_unavailable"})
			return
		}
		writeDelegationJournalResponse(w, req, authority, record)
	})
}

func writeDelegationJournalResponse(w http.ResponseWriter, req *http.Request, authority *delegationauth.Authority, record any) {
	body, err := json.Marshal(map[string]any{"record": record})
	if err != nil {
		envelope.WriteJSON(w, http.StatusInternalServerError, map[string]string{"status": "journal_unavailable"})
		return
	}
	body = append(body, '\n')
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-AO-Delegation-Response-MAC", authority.ResponseMAC(body, req.Header.Get("X-AO-Delegation-MAC")))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
