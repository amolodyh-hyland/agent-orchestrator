package domain

import (
	"crypto/sha256"
	"encoding/hex"
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

func TestSpecialistResultSharedTextVectors(t *testing.T) {
	data, err := os.ReadFile("../../../test/contracts/multica-delegation-result-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Result SpecialistResult `json:"result"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile("../../../test/contracts/multica-result-text-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Refused []string `json:"refused"`
		Allowed []string `json:"allowed"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	validate := func(text string) error {
		r := fixture.Result
		r.Text, r.ByteCount, r.Revision = text, len(text), ""
		sum := sha256.Sum256([]byte(text))
		r.Digest = hex.EncodeToString(sum[:])
		data, err := json.Marshal(r)
		if err != nil {
			t.Fatal(err)
		}
		sum = sha256.Sum256(data)
		r.Revision = hex.EncodeToString(sum[:])
		return r.Validate()
	}
	for _, value := range vectors.Refused {
		if validate(value) == nil {
			t.Errorf("unsafe result accepted: %q", value)
		}
	}
	for _, value := range vectors.Allowed {
		if err := validate(value); err != nil {
			t.Errorf("safe result refused: %q: %v", value, err)
		}
	}
}
