package httpd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/outer"
)

type nativeOuterInput struct {
	Operation         string                       `json:"operation"`
	ID                string                       `json:"id"`
	SessionID         domain.SessionID             `json:"sessionId"`
	Text              string                       `json:"text"`
	Expected          *domain.OuterSendExpectation `json:"expected"`
	Config            domain.AgentConfig           `json:"config"`
	Revision          int64                        `json:"revision"`
	ProjectIDs        []string                     `json:"projectIds"`
	Paused            bool                         `json:"paused"`
	ForegroundReserve bool                         `json:"foregroundReserve"`
	Control           *nativeOuterControl          `json:"control"`
	Nonce             string                       `json:"nonce"`
	Expires           int64                        `json:"expires"`
}
type nativeOuterControl struct {
	Action     string          `json:"action"`
	TargetID   string          `json:"targetId"`
	PendingID  string          `json:"pendingId"`
	Generation string          `json:"generation"`
	Body       json.RawMessage `json:"body"`
}
type outerControlRoute struct{ Method, Path, Operation, Owner string }

var outerNativeControls = map[string]outerControlRoute{
	"session.spawn":       {"POST", "/sessions", "spawn", "body"},
	"orchestrator.ensure": {"POST", "/orchestrators", "spawn", "body"},
	"session.send":        {"POST", "/sessions/%s/send", "send", "session"},
	"session.restore":     {"POST", "/sessions/%s/restore", "restore", "session"},
	"session.resume":      {"POST", "/sessions/%s/resume-agent", "resume", "session"},
	"session.kill":        {"POST", "/sessions/%s/kill", "kill", "session"},
	"session.switch":      {"POST", "/sessions/%s/switch-agent", "switch", "session"},
	"chat.send":           {"POST", "/sessions/%s/conversation/messages", "send", "session"},
	"chat.settings":       {"PATCH", "/sessions/%s/conversation/settings", "settings", "session"},
	"chat.approval":       {"POST", "/sessions/%s/conversation/approvals/%s/resolve", "outer.reply.approval", "session"},
	"chat.input":          {"POST", "/sessions/%s/conversation/inputs/%s/resolve", "outer.reply.input", "session"},
	"chat.cancel":         {"POST", "/sessions/%s/conversation/turns/%s/cancel", "queue.cancel", "session"},
	"project.settings":    {"PUT", "/projects/%s", "project.settings", "project"},
	"project.config":      {"PUT", "/projects/%s/config", "project.config", "project"},
	"project.permissions": {"PATCH", "/projects/%s/permissions", "project.permissions", "project"},
	"task.prepare":        {"POST", "/projects/%s/tasks/prepare", "spawn", "project"},
	"run.create":          {"POST", "/runs", "run.create", "body"},
	"run.evidence":        {"POST", "/runs/%s/evidence", "run.evidence", "run"},
	"run.advance":         {"POST", "/runs/%s/advance", "run.advance", "run"},
	"review.trigger":      {"POST", "/sessions/%s/reviews/trigger", "review.trigger", "session"},
	"review.cancel":       {"POST", "/sessions/%s/reviews/cancel", "review.cancel", "session"},
	"pr.merge":            {"POST", "/prs/%s/merge", "pr.merge", "pr"},
	"pr.resolve":          {"POST", "/prs/%s/resolve-comments", "pr.resolve", "pr"},
}

func mountOuterNative(r chi.Router, svc *outer.Service, authority *delegationauth.Authority) {
	if svc == nil {
		return
	}
	r.Post("/internal/outer/native", func(w http.ResponseWriter, req *http.Request) {
		reject := func() {
			_ = svc.Deny(req.Context(), "outer.native", "unbound_stale_or_unsupported_native_action", "")
			envelope.WriteAPIError(w, req, 409, "conflict", "OUTER_HELD", "Outer action held; use the exact supported desktop control", nil)
		}
		if !localControlRequest(req) || authority == nil {
			reject()
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, req.Body, 256<<10))
		proof := req.Header.Get("X-AO-Delegation-MAC")
		if err != nil || !authority.AuthorizeOuter(raw, proof) {
			reject()
			return
		}
		var in nativeOuterInput
		if domain.StrictDelegationJSON(raw, &in) != nil || !authority.ConsumeRun(in.Nonce, in.Expires) {
			reject()
			return
		}
		if len(in.ID) < 16 || len(in.ID) > 128 {
			reject()
			return
		}
		req = req.WithContext(domain.WithOuterNativeAction(req.Context(), domain.OuterNativeAction{Operation: "outer.native", ActionID: in.ID}))
		if err := svc.RecordNativeAction(req.Context(), in.ID, raw); err != nil {
			reject()
			return
		}
		var value any
		switch in.Operation {
		case "setup":
			value, err = svc.Ensure(domain.WithOuterNativeAction(req.Context(), domain.OuterNativeAction{Operation: "outer.setup"}), in.Config)
		case "scope":
			value, err = svc.SetScope(domain.WithOuterNativeAction(req.Context(), domain.OuterNativeAction{Operation: "outer.scope"}), in.Revision, in.ProjectIDs, in.Paused, in.ForegroundReserve)
		case "send":
			if len(in.ID) < 16 || len(in.ID) > 128 {
				reject()
				return
			}
			value, err = svc.Send(domain.WithOuterNativeAction(req.Context(), domain.OuterNativeAction{Operation: "outer.send", RequestID: in.ID, SessionID: in.SessionID, Expected: in.Expected}), in.Text)
		case "control":
			if in.Control == nil {
				reject()
				return
			}
			controlOuterNative(w, req, r, svc, authority, *in.Control)
			return
		default:
			reject()
			return
		}
		if err != nil {
			reject()
			return
		}
		writeDelegationJournalResponse(w, req, authority, value)
	})
}

func controlOuterNative(w http.ResponseWriter, req *http.Request, router chi.Router, svc *outer.Service, authority *delegationauth.Authority, in nativeOuterControl) {
	reject := func() {
		_ = svc.Deny(req.Context(), "outer.native.control", "unsupported_stale_or_unresolved_control", "")
		envelope.WriteAPIError(w, req, 409, "conflict", "OUTER_HELD", "Unsupported or stale desktop control", nil)
	}
	if in.Action == "terminal.bind" {
		value, err := svc.BindTerminal(domain.WithOuterNativeAction(req.Context(), domain.OuterNativeAction{Operation: "terminal.bind"}), in.TargetID)
		if err != nil {
			reject()
			return
		}
		writeDelegationJournalResponse(w, req, authority, value)
		return
	}
	route, ok := outerNativeControls[in.Action]
	if !ok || len(in.TargetID) > 256 || len(in.PendingID) > 256 {
		reject()
		return
	}
	path := route.Path
	if strings.Count(path, "%s") > 0 {
		path = strings.Replace(path, "%s", url.PathEscape(in.TargetID), 1)
	}
	path = strings.Replace(path, "%s", url.PathEscape(in.PendingID), 1)
	forward, err := http.NewRequestWithContext(req.Context(), route.Method, "http://127.0.0.1/api/v1"+path, bytes.NewReader(in.Body))
	if err != nil {
		reject()
		return
	}
	match := chi.NewRouteContext()
	if !router.Match(match, route.Method, forward.URL.Path) {
		reject()
		return
	}
	project, session, err := resolveOuterRouteTarget(w, forward, match, match.RoutePattern(), svc)
	if err != nil {
		reject()
		return
	}
	b, bound, err := svc.Binding(req.Context())
	if err != nil {
		reject()
		return
	}
	if bound && string(project) == b.AnchorProjectID {
		if session != b.SessionID || b.HistoryHeld {
			reject()
			return
		}
		switch in.Action {
		case "chat.settings", "chat.approval", "chat.input", "chat.cancel", "session.resume":
		default:
			reject()
			return
		}
	}
	a := domain.OuterNativeAction{Operation: route.Operation, ProjectID: project, SessionID: session, RequestID: in.PendingID, Generation: in.Generation}
	ctx := domain.WithOuterNativeAction(context.WithValue(req.Context(), outerNativeRelayKey{}, true), a)
	finish, err := svc.BeginNativeControl(ctx, a, domain.OuterDigest(in))
	if err != nil {
		reject()
		return
	}
	completed := false
	defer func() { _ = finish(completed) }()
	ctx = context.WithValue(ctx, chi.RouteCtxKey, nil)
	forward = forward.WithContext(ctx)
	forward.RemoteAddr = req.RemoteAddr
	forward.Header.Set("content-type", "application/json")
	recorder := &outerNativeRecorder{header: make(http.Header)}
	router.ServeHTTP(recorder, forward)
	if recorder.status < 200 || recorder.status >= 300 {
		reject()
		return
	}
	var value any
	if len(recorder.body) > 0 && json.Unmarshal(recorder.body, &value) != nil {
		reject()
		return
	}
	completed = true
	writeDelegationJournalResponse(w, req, authority, value)
}

type outerNativeRelayKey struct{}
type outerNativeRecorder struct {
	header http.Header
	body   []byte
	status int
}

func (w *outerNativeRecorder) Header() http.Header { return w.header }
func (w *outerNativeRecorder) WriteHeader(n int)   { w.status = n }
func (w *outerNativeRecorder) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	if len(w.body)+len(p) > 4<<20 {
		return 0, domain.ErrOuterHeld
	}
	w.body = append(w.body, p...)
	return len(p), nil
}
