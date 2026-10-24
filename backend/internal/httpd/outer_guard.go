package httpd

import (
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/outer"
)

func outerGuard(router chi.Router, svc *outer.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if svc == nil || !strings.HasPrefix(r.URL.Path, "/api/v1/") {
				next.ServeHTTP(w, r)
				return
			}
			b, found, err := svc.Binding(r.Context())
			if err != nil {
				envelope.WriteAPIError(w, r, 409, "conflict", "OUTER_HELD", "Outer policy unavailable", nil)
				return
			}
			if !found {
				next.ServeHTTP(w, r)
				return
			}
			ctx := r.Context()
			if token := r.Header.Get("X-AO-Scope-Credential"); token != "" {
				caller, err := svc.AuthenticateCaller(ctx, token)
				if err != nil {
					envelope.WriteAPIError(w, r, 409, "conflict", "OUTER_HELD", "Scoped session authority is stale or missing", nil)
					return
				}
				ctx = domain.WithOuterCaller(ctx, caller)
				r = r.WithContext(ctx)
			}
			read := r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions
			if read {
				if caller, ok := domain.OuterCallerFrom(ctx); ok && caller.Outer && !strings.HasPrefix(r.URL.Path, "/api/v1/outer") {
					_ = svc.Deny(ctx, "outer.read", "use_bounded_outer_projection", "")
					envelope.WriteAPIError(w, r, 409, "conflict", "OUTER_HELD", "Use bounded selected-project facts", nil)
					return
				}
				// Session reads must never ensure or resume a controller.
				if strings.HasPrefix(r.URL.Path, "/api/v1/sessions") {
					q := r.URL.Query()
					q.Set("readOnly", "true")
					r.URL.RawQuery = q.Encode()
				}
				next.ServeHTTP(w, r)
				return
			}
			match := chi.NewRouteContext()
			if !router.Match(match, r.Method, r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			pattern := match.RoutePattern()
			op, classified := outerMutationManifest[r.Method+" "+pattern]
			if !classified {
				op = "unclassified"
			}
			project, session, targetErr := resolveOuterRouteTarget(w, r, match, pattern, svc)
			err = targetErr
			if a, ok := domain.OuterNativeActionFrom(ctx); ok && ctx.Value(outerNativeRelayKey{}) == true {
				if project == a.ProjectID && session == a.SessionID {
					op = a.Operation
					classified = true
				}
			}
			if err == nil && classified {
				err = svc.AuthorizeOperation(ctx, op, project, session)
			} else {
				err = svc.Deny(ctx, op, "unresolved_or_unclassified_target", string(project))
			}
			if err != nil {
				if session != "" && string(project) == b.AnchorProjectID {
					// Retain the bounded incoming claim as inert evidence, never as a
					// conversation message or executable queue entry. Authorship in
					// this JSON remains an untrusted claim.
					incoming := "Held incoming route: " + r.Method + " " + pattern
					if r.Body != nil {
						if raw, readErr := io.ReadAll(io.LimitReader(r.Body, 60<<10)); readErr == nil {
							incoming += "\n" + string(raw)
						}
					}
					_ = svc.RetainIncoming(ctx, session, incoming)
				}
				envelope.WriteAPIError(w, r, 409, "conflict", "OUTER_HELD", "Action held; use a supported native control or a live project-local credential", nil)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

var outerMutationManifest = map[string]string{
	"POST /api/v1/outer/plans":                                                                         "outer.plan.propose",
	"POST /api/v1/awake/downloads":                                                                     "native_only",
	"DELETE /api/v1/awake/history":                                                                     "native_only",
	"POST /api/v1/awake/low-power/authorize":                                                           "native_only",
	"POST /api/v1/awake/low-power/revoke":                                                              "native_only",
	"POST /api/v1/awake/recover":                                                                       "native_only",
	"POST /api/v1/awake/resume":                                                                        "native_only",
	"PUT /api/v1/awake/rules":                                                                          "native_only",
	"POST /api/v1/awake/sessions":                                                                      "session.scoped",
	"POST /api/v1/awake/sessions/{awakeId}/end":                                                        "session.scoped",
	"POST /api/v1/awake/sessions/{awakeId}/extend":                                                     "session.scoped",
	"PUT /api/v1/awake/settings":                                                                       "native_only",
	"POST /api/v1/awake/stop":                                                                          "native_only",
	"PATCH /api/v1/mobile/devices/{installId}":                                                         "native_only",
	"DELETE /api/v1/mobile/devices/{installId}":                                                        "native_only",
	"POST /api/v1/agents/accounts/login":                                                               "native_only",
	"POST /api/v1/agents/accounts/login/{operationId}/cancel":                                          "native_only",
	"POST /api/v1/agents/accounts/login/{operationId}/verify":                                          "native_only",
	"PUT /api/v1/agents/accounts/sessions/{sessionId}":                                                 "session.scoped",
	"DELETE /api/v1/agents/accounts/{accountId}":                                                       "native_only",
	"POST /api/v1/agents/accounts/{accountId}/default":                                                 "native_only",
	"POST /api/v1/agents/accounts/{accountId}/login":                                                   "native_only",
	"POST /api/v1/agents/accounts/{accountId}/reset-credit":                                            "native_only",
	"POST /api/v1/agents/codex/account-switches":                                                       "native_only",
	"POST /api/v1/agents/codex/accounts/ensure":                                                        "native_only",
	"POST /api/v1/agents/codex/accounts/login-operations/{operationId}/cancel":                         "native_only",
	"POST /api/v1/agents/codex/accounts/login-operations/{operationId}/verify":                         "native_only",
	"POST /api/v1/agents/codex/accounts/login-terminal":                                                "native_only",
	"DELETE /api/v1/agents/codex/accounts/{accountId}":                                                 "native_only",
	"POST /api/v1/agents/codex/accounts/{accountId}/login-terminal":                                    "native_only",
	"POST /api/v1/agents/codex/accounts/{accountId}/logout":                                            "native_only",
	"POST /api/v1/agents/codex/accounts/{accountId}/reset-credit/consume":                              "native_only",
	"POST /api/v1/agents/readiness/ensure":                                                             "native_only",
	"POST /api/v1/agents/refresh":                                                                      "native_only",
	"POST /api/v1/agents/{agent}/auth":                                                                 "native_only",
	"POST /api/v1/agents/{agent}/install":                                                              "native_only",
	"POST /api/v1/agents/{agent}/install/cancel":                                                       "native_only",
	"POST /api/v1/agents/{agent}/logout":                                                               "native_only",
	"POST /api/v1/agents/{agent}/models/refresh":                                                       "native_only",
	"POST /api/v1/agents/{agent}/probe":                                                                "native_only",
	"POST /api/v1/agents/{agent}/verify":                                                               "native_only",
	"POST /api/v1/automations":                                                                         "native_only",
	"PATCH /api/v1/automations/{automationId}":                                                         "native_only",
	"DELETE /api/v1/automations/{automationId}":                                                        "native_only",
	"POST /api/v1/browser/commands":                                                                    "native_only",
	"PATCH /api/v1/cues/{cueId}":                                                                       "native_only",
	"DELETE /api/v1/cues/{cueId}":                                                                      "native_only",
	"POST /api/v1/cues/{cueId}/invoke":                                                                 "native_only",
	"POST /api/v1/dev/import-projects":                                                                 "native_only",
	"DELETE /api/v1/github/pat":                                                                        "native_only",
	"PUT /api/v1/github/pat":                                                                           "native_only",
	"POST /api/v1/import":                                                                              "native_only",
	"POST /api/v1/imports/prepare-git":                                                                 "native_only",
	"POST /api/v1/imports/validate":                                                                    "native_only",
	"POST /api/v1/library/operations":                                                                  "native_only",
	"POST /api/v1/multica/restart":                                                                     "native_only",
	"POST /api/v1/multica/start":                                                                       "native_only",
	"POST /api/v1/multica/stop":                                                                        "native_only",
	"DELETE /api/v1/notifications":                                                                     "native_only",
	"POST /api/v1/notifications/clear-through":                                                         "native_only",
	"POST /api/v1/notifications/read-all":                                                              "native_only",
	"DELETE /api/v1/notifications/{id}":                                                                "native_only",
	"PATCH /api/v1/notifications/{id}":                                                                 "native_only",
	"POST /api/v1/orchestrators":                                                                       "session.scoped",
	"POST /api/v1/orchestrators/delegate":                                                              "session.scoped",
	"POST /api/v1/projects":                                                                            "project.scoped",
	"POST /api/v1/projects/clone":                                                                      "project.scoped",
	"POST /api/v1/projects/clone/cleanup":                                                              "project.scoped",
	"POST /api/v1/projects/clone/prepare":                                                              "project.scoped",
	"POST /api/v1/projects/containers":                                                                 "project.scoped",
	"POST /api/v1/projects/initialize":                                                                 "project.scoped",
	"DELETE /api/v1/projects/{id}":                                                                     "project.scoped",
	"PUT /api/v1/projects/{id}":                                                                        "project.scoped",
	"PUT /api/v1/projects/{id}/config":                                                                 "project.scoped",
	"POST /api/v1/projects/{projectId}/cues":                                                           "project.scoped",
	"PATCH /api/v1/projects/{id}/permissions":                                                          "project.scoped",
	"POST /api/v1/projects/{id}/tasks/prepare":                                                         "project.scoped",
	"POST /api/v1/prs/{id}/merge":                                                                      "pr.scoped",
	"POST /api/v1/prs/{id}/resolve-comments":                                                           "pr.scoped",
	"POST /api/v1/push/devices":                                                                        "native_only",
	"DELETE /api/v1/push/devices/{token}":                                                              "native_only",
	"DELETE /api/v1/push/pairings/{id}":                                                                "native_only",
	"POST /api/v1/reports":                                                                             "report.scoped",
	"POST /api/v1/reports/{reportId}/resolve":                                                          "report.scoped",
	"POST /api/v1/reviews/{reviewSessionID}/activity":                                                  "review.scoped",
	"POST /api/v1/reviews/{reviewId}/conversation/approvals/{requestId}/resolve":                       "conversation.held",
	"POST /api/v1/reviews/{reviewId}/conversation/inputs/{requestId}/resolve":                          "conversation.held",
	"POST /api/v1/reviews/{reviewId}/conversation/interrupt":                                           "conversation.held",
	"POST /api/v1/reviews/{reviewId}/conversation/messages":                                            "conversation.held",
	"PATCH /api/v1/reviews/{reviewId}/conversation/settings":                                           "conversation.held",
	"POST /api/v1/runs":                                                                                "run.scoped",
	"POST /api/v1/runs/{runId}/advance":                                                                "run.scoped",
	"POST /api/v1/runs/{runId}/attention":                                                              "run.scoped",
	"POST /api/v1/runs/{runId}/evidence":                                                               "run.scoped",
	"POST /api/v1/runs/{runId}/monitor":                                                                "run.scoped",
	"POST /api/v1/sessions":                                                                            "session.scoped",
	"POST /api/v1/sessions/cleanup":                                                                    "session.scoped",
	"PATCH /api/v1/sessions/{sessionId}":                                                               "session.scoped",
	"POST /api/v1/sessions/{sessionId}/activity":                                                       "session.scoped",
	"POST /api/v1/sessions/{sessionId}/activity/codewhale":                                             "session.scoped",
	"POST /api/v1/sessions/{sessionId}/agent-browser/*":                                                "session.scoped",
	"POST /api/v1/sessions/{sessionId}/agent-switches/{switchId}/handoff":                              "session.scoped",
	"POST /api/v1/sessions/{sessionId}/agent-switches/{switchId}/recover":                              "session.scoped",
	"DELETE /api/v1/sessions/{sessionId}/artifact-files":                                               "session.scoped",
	"PUT /api/v1/sessions/{sessionId}/artifact-files":                                                  "session.scoped",
	"POST /api/v1/sessions/{sessionId}/artifact-versions/restore":                                      "session.scoped",
	"POST /api/v1/sessions/{sessionId}/artifact-versions/sync":                                         "session.scoped",
	"POST /api/v1/sessions/{sessionId}/attachments":                                                    "session.scoped",
	"PATCH /api/v1/sessions/{sessionId}/auto-inject-ci":                                                "session.scoped",
	"PATCH /api/v1/sessions/{sessionId}/auto-inject-review":                                            "session.scoped",
	"PUT /api/v1/sessions/{sessionId}/auto-review":                                                     "session.scoped",
	"POST /api/v1/sessions/{sessionId}/chat-view":                                                      "session.scoped",
	"POST /api/v1/sessions/{sessionId}/conversation/approvals/{requestId}/resolve":                     "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/branches/{branchId}/activate":                      "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/compact":                                           "conversation.held",
	"PATCH /api/v1/sessions/{sessionId}/conversation/config-options/{configId}":                        "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/inputs/{requestId}/resolve":                        "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/interrupt":                                         "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/mcp/reload":                                        "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/messages":                                          "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/prompt-suggestion":                                 "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/queue/reorder":                                     "conversation.held",
	"PATCH /api/v1/sessions/{sessionId}/conversation/settings":                                         "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/side-chats":                                        "conversation.held",
	"DELETE /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}":                             "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/approvals/{requestId}/resolve": "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/compact":                       "conversation.held",
	"PUT /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/draft":                          "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/inputs/{requestId}/resolve":    "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/interrupt":                     "conversation.held",
	"PATCH /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/label":                        "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/messages":                      "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/recover":                       "conversation.held",
	"PATCH /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/settings":                     "conversation.held",
	"PATCH /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/turns/{turnId}":               "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/turns/{turnId}/cancel":         "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/side-chats/{sideId}/turns/{turnId}/retry":          "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/skills/refresh":                                    "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/steer":                                             "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/steer-or-send":                                     "conversation.held",
	"PUT /api/v1/sessions/{sessionId}/conversation/title":                                              "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/turns/{turnId}/cancel":                             "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/turns/{turnId}/edit":                               "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/turns/{turnId}/queue/edit":                         "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/turns/{turnId}/retry":                              "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/turns/{turnId}/rollback":                           "conversation.held",
	"POST /api/v1/sessions/{sessionId}/conversation/turns/{turnId}/steer":                              "conversation.held",
	"POST /api/v1/sessions/{sessionId}/exit-agent":                                                     "session.scoped",
	"POST /api/v1/sessions/{sessionId}/interface-transition":                                           "session.scoped",
	"DELETE /api/v1/sessions/{sessionId}/interface-transition":                                         "session.scoped",
	"PUT /api/v1/sessions/{sessionId}/interface-transition/{transitionId}/notice-acknowledgement":      "session.scoped",
	"POST /api/v1/sessions/{sessionId}/kill":                                                           "session.scoped",
	"PATCH /api/v1/sessions/{sessionId}/merge-policy":                                                  "session.scoped",
	"POST /api/v1/sessions/{sessionId}/pin":                                                            "session.scoped",
	"DELETE /api/v1/sessions/{sessionId}/pin":                                                          "session.scoped",
	"POST /api/v1/sessions/{sessionId}/pr/claim":                                                       "session.scoped",
	"DELETE /api/v1/sessions/{sessionId}/preview":                                                      "session.scoped",
	"POST /api/v1/sessions/{sessionId}/preview":                                                        "session.scoped",
	"POST /api/v1/sessions/{sessionId}/preview/app/*":                                                  "session.scoped",
	"PUT /api/v1/sessions/{sessionId}/preview/app/*":                                                   "session.scoped",
	"PATCH /api/v1/sessions/{sessionId}/preview/app/*":                                                 "session.scoped",
	"DELETE /api/v1/sessions/{sessionId}/preview/app/*":                                                "session.scoped",
	"DELETE /api/v1/sessions/{sessionId}/preview/server":                                               "session.scoped",
	"POST /api/v1/sessions/{sessionId}/preview/server":                                                 "session.scoped",
	"POST /api/v1/sessions/{sessionId}/renders":                                                        "session.scoped",
	"POST /api/v1/sessions/{sessionId}/renders/check":                                                  "session.scoped",
	"POST /api/v1/sessions/{sessionId}/renders/{renderId}/artifact":                                    "session.scoped",
	"POST /api/v1/sessions/{sessionId}/restore":                                                        "session.scoped",
	"POST /api/v1/sessions/{sessionId}/resume-agent":                                                   "session.scoped",
	"PUT /api/v1/sessions/{sessionId}/reviewer":                                                        "session.scoped",
	"POST /api/v1/sessions/{sessionId}/reviews/cancel":                                                 "session.scoped",
	"POST /api/v1/sessions/{sessionId}/reviews/comments/resolve":                                       "session.scoped",
	"POST /api/v1/sessions/{sessionId}/reviews/kill":                                                   "session.scoped",
	"POST /api/v1/sessions/{sessionId}/reviews/rerequest":                                              "session.scoped",
	"POST /api/v1/sessions/{sessionId}/reviews/restore":                                                "session.scoped",
	"POST /api/v1/sessions/{sessionId}/reviews/submit":                                                 "session.scoped",
	"POST /api/v1/sessions/{sessionId}/reviews/switch":                                                 "session.scoped",
	"POST /api/v1/sessions/{sessionId}/reviews/trigger":                                                "session.scoped",
	"POST /api/v1/sessions/{sessionId}/rollback":                                                       "session.scoped",
	"POST /api/v1/sessions/{sessionId}/send":                                                           "session.scoped",
	"POST /api/v1/sessions/{sessionId}/switch-agent":                                                   "session.scoped",
	"POST /api/v1/sessions/{sessionId}/workspace/diffs":                                                "session.scoped",
	"PUT /api/v1/sessions/{sessionId}/workspace/file":                                                  "session.scoped",
	"PATCH /api/v1/settings/chat-hibernation":                                                          "native_only",
	"PATCH /api/v1/settings/cloud-offering":                                                            "native_only",
	"PATCH /api/v1/settings/harness-defaults/{agent}":                                                  "native_only",
	"PATCH /api/v1/settings/session-interface":                                                         "native_only",
	"PATCH /api/v1/settings/version-refresh":                                                           "native_only",
	"POST /api/v1/shell-terminals":                                                                     "native_only",
	"PATCH /api/v1/shell-terminals/{handleId}":                                                         "native_only",
	"DELETE /api/v1/shell-terminals/{handleId}":                                                        "native_only",
	"POST /api/v1/side-chats/launch/claim":                                                             "native_only",
	"POST /api/v1/side-chats/launch/retire":                                                            "native_only",
	"POST /api/v1/side-chats/launch/state":                                                             "native_only",
	"POST /api/v1/system/github-auth/terminal":                                                         "native_only",
	"POST /api/v1/system/install/{target}":                                                             "native_only",
	"DELETE /api/v1/task-preparations/{token}":                                                         "native_only",
}
