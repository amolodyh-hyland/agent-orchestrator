package domain

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestSpecialistResultPairedContract(t *testing.T) {
	data, err := os.ReadFile("../../../test/contracts/multica-delegation-result-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Result SpecialistResult `json:"result"`
	}
	if json.Unmarshal(data, &fixture) != nil {
		t.Fatal("invalid fixture")
	}
	if err := fixture.Result.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*SpecialistResult){func(r *SpecialistResult) { r.Text += "changed" }, func(r *SpecialistResult) { r.Digest = strings.Repeat("0", 64) }, func(r *SpecialistResult) { r.Status = "running" }, func(r *SpecialistResult) { r.Text = "" }, func(r *SpecialistResult) { r.Text = strings.Repeat("x", 32769) }, func(r *SpecialistResult) { r.Text = "https://private.test" }} {
		r := fixture.Result
		mutate(&r)
		if r.Validate() == nil {
			t.Fatal("invalid result accepted")
		}
	}
}
