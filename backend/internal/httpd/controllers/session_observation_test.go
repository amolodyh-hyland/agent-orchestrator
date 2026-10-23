package controllers

import (
	"net/http/httptest"
	"testing"
)

func TestParseSessionListReadOnly(t *testing.T) {
	for _, tc := range []struct {
		query             string
		readOnly, invalid bool
	}{
		{"?project=a&readOnly=true", true, false},
		{"?readOnly=false", false, false},
		{"", false, false},
		{"?readOnly=maybe", false, true},
	} {
		t.Run(tc.query, func(t *testing.T) {
			filter, err := parseSessionListFilter(httptest.NewRequest("GET", "/sessions"+tc.query, nil))
			if (err != nil) != tc.invalid || filter.ReadOnly != tc.readOnly {
				t.Fatalf("filter=%+v err=%v", filter, err)
			}
			if tc.readOnly && string(filter.ProjectID) != "a" {
				t.Fatal("lost project scope")
			}
		})
	}
}
