package specgen

import (
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/outer"
	"net/http"
)

func outerOperations() []operation {
	errors := []respUnit{{http.StatusConflict, envelope.APIError{}}, {http.StatusInternalServerError, envelope.APIError{}}, {http.StatusNotImplemented, envelope.APIError{}}}
	return []operation{
		{method: http.MethodGet, path: "/api/v1/outer", id: "getOuter", tag: "outer", summary: "Read outer binding and observation-only receipts", resps: append([]respUnit{{http.StatusOK, outer.View{}}}, errors...)},
		{method: http.MethodGet, path: "/api/v1/outer/facts", id: "getOuterFacts", tag: "outer", summary: "Read bounded selected-project evidence with source labels", pathParams: []any{controllers.OuterFactsQuery{}}, resps: append([]respUnit{{http.StatusOK, controllers.OuterFactsResponse{}}}, errors...)},
		{method: http.MethodGet, path: "/api/v1/outer/audit", id: "getOuterAudit", tag: "outer", summary: "Read a bounded outer timeline page", pathParams: []any{controllers.OuterAuditQuery{}}, resps: append([]respUnit{{http.StatusOK, controllers.OuterAuditResponse{}}}, errors...)},
	}
}
