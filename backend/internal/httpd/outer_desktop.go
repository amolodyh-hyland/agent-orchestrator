package httpd

import (
	_ "embed"
	"encoding/json"
	"net/url"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// The renderer and native main process import this same finite catalog. A
// desktop confirmation is never an arbitrary URL, method, header or signer.
//
//go:embed outer_desktop_routes.json
var outerDesktopRoutesJSON []byte

type outerDesktopRoute struct {
	Operation string `json:"operation"`
	Mode      string `json:"mode"`
}

var outerDesktopRoutes = func() map[string]outerDesktopRoute {
	var routes map[string]outerDesktopRoute
	if err := json.Unmarshal(outerDesktopRoutesJSON, &routes); err != nil {
		panic(err)
	}
	return routes
}()

type outerDesktopRequest struct {
	Route            string          `json:"route"`
	Parameters       []string        `json:"parameters"`
	Query            string          `json:"query"`
	Payload          json.RawMessage `json:"payload"`
	AttachmentUpload bool            `json:"attachmentUpload"`
}

// Existing outer Send/setup/reply journals retain their exact private content.
// Ordinary desktop forms can carry credentials. Bind their entire immutable
// request and control by digest without duplicating secrets into the journal.
// This receipt cannot replay an action; unknown outcomes always need inspection.
func outerNativeJournal(in nativeOuterInput, raw []byte) []byte {
	if in.Operation != "control" || in.Control == nil || in.Control.Action != "desktop.control" {
		return raw
	}
	var request outerDesktopRequest
	_ = json.Unmarshal(in.Control.Body, &request)
	route := "unsupported"
	if _, found := outerDesktopRoutes[request.Route]; found {
		route = request.Route
	}
	document, _ := json.Marshal(map[string]any{
		"id": in.ID, "operation": "desktop.control", "route": route,
		"requestDigest": domain.OuterDigest(string(raw)), "controlDigest": domain.OuterDigest(in.Control),
	})
	return document
}

func resolveOuterDesktop(in nativeOuterControl) (outerControlRoute, outerDesktopRequest, error) {
	var request outerDesktopRequest
	if in.TargetID != "" || in.PendingID != "" || in.Generation != "" || domain.StrictDelegationJSON(in.Body, &request) != nil {
		return outerControlRoute{}, request, domain.ErrOuterHeld
	}
	route, found := outerDesktopRoutes[request.Route]
	if !found || route.Mode != "confirm" || len(request.Query) > 4096 {
		return outerControlRoute{}, request, domain.ErrOuterHeld
	}
	method, path, ok := strings.Cut(request.Route, " ")
	if !ok || !strings.HasPrefix(path, "/api/v1/") {
		return outerControlRoute{}, request, domain.ErrOuterHeld
	}
	parts := strings.Split(path, "/")
	n := 0
	for i, part := range parts {
		if !strings.HasPrefix(part, "{") {
			continue
		}
		if n >= len(request.Parameters) || request.Parameters[n] == "" || len(request.Parameters[n]) > 256 || strings.ContainsAny(request.Parameters[n], "/\\\x00") || request.Parameters[n] == "." || request.Parameters[n] == ".." {
			return outerControlRoute{}, request, domain.ErrOuterHeld
		}
		parts[i] = url.PathEscape(request.Parameters[n])
		n++
	}
	if n != len(request.Parameters) {
		return outerControlRoute{}, request, domain.ErrOuterHeld
	}
	path = strings.Join(parts, "/")
	if request.Query != "" {
		query, err := url.ParseQuery(request.Query)
		if err != nil {
			return outerControlRoute{}, request, domain.ErrOuterHeld
		}
		path += "?" + query.Encode()
	}
	return outerControlRoute{Method: method, Path: strings.TrimPrefix(path, "/api/v1"), Operation: route.Operation}, request, nil
}
