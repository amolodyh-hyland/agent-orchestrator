package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func vectorEntry(data string) LibraryEntry {
	return LibraryEntry{SchemaVersion: 1, EntryID: "ent_review", SourceID: "src_personal", Kind: "rule", DisplayName: "Review guidance", Format: "plain-rule-v1", EntryPoint: "rules/review.md", Files: []LibraryFile{{Path: "rules/review.md", SHA256: LibraryBytesHash([]byte(data)), SizeBytes: int64(len(data)), Mode: "text"}}, Requirements: []string{}}
}
func TestLibraryGoldenEntryVectors(t *testing.T) {
	for _, tc := range []struct{ data, hash string }{
		{"Review selected changes.\n", "sha256:26eb5fd1696af1e0c83b85a2933f699fb93c286ba0ca4e0056f528e174cbb94d"},
		{"Review selected changes carefully.\n", "sha256:d7108c9dd9c4b5ec1c67a81800dd1a9fb9f1e0fdf27499fff7f80873d18016e9"},
	} {
		e := vectorEntry(tc.data)
		got, err := e.ComputeContentHash()
		if err != nil || got != tc.hash {
			t.Fatalf("hash=%s err=%v", got, err)
		}
		e.DisplayName = "Renamed"
		e.EntryID = "different"
		e.SourceID = "other"
		same, _ := e.ComputeContentHash()
		if same != got {
			t.Fatal("presentation changed hash")
		}
	}
	baseline, _ := vectorEntry("Review selected changes.\n").ComputeContentHash()
	for _, text := range []string{"Review selected changes.\r\n", "Review selected changes. \n", "---\nname: review\n---\nReview selected changes.\n"} {
		hash, _ := vectorEntry(text).ComputeContentHash()
		if hash == baseline {
			t.Fatal("raw bytes not hashed")
		}
	}
	e := vectorEntry("hello")
	e.Files = append(e.Files, LibraryFile{Path: "rules/support.txt", SHA256: LibraryBytesHash([]byte("one")), SizeBytes: 3, Mode: "text"})
	a, _ := e.ComputeContentHash()
	e.Files[1].SHA256 = LibraryBytesHash([]byte("two"))
	b, _ := e.ComputeContentHash()
	if a == b {
		t.Fatal("support file not hashed")
	}
}
func TestLibraryGoldenRecordVectors(t *testing.T) {
	raw := `{"entries":[{"contentHash":"sha256:` + strings.Repeat("0", 64) + `","entryId":"ent_1"}],"purposes":["load_context"],"rootIdentity":{"resolverId":"resolver_1","rootGeneration":1,"rootRef":"root_1"},"policyRevision":""}`
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatal(err)
	}
	for domain, want := range map[string]string{"shared-library-approval-v1": "sha256:686699d0a9718c80bdac9d9285292f3462beda953f22cb127e539d65642f008e", "shared-library-transfer-v1": "sha256:8cc886c118ccaea745e707f0837b3d6b29e5942c1baee9006d61904a52cc562b", "shared-library-session-v1": "sha256:a820c526f78055ecbf64911acde760c1e61e0b4ff1e118552f0edcf15777aa82"} {
		got, err := LibraryRecordDigest(domain, value)
		if err != nil || got != want {
			t.Fatalf("%s=%s err=%v", domain, got, err)
		}
	}
}
func TestLibraryCanonicalJSON(t *testing.T) {
	got, err := CanonicalLibraryJSON([]byte(`{"z":"é/\n\t\u0000","a":{"b":2,"a":1}}`))
	if err != nil || string(got) != `{"a":{"a":1,"b":2},"z":"é/\u000a\u0009\u0000"}` {
		t.Fatalf("canonical=%s err=%v", got, err)
	}
	for _, raw := range []string{`{"a":1,"a":2}`, `{"v":1.0}`, `{"v":1e3}`, `{"v":"\ud800"}`, `{"v":"\udc00"}`, `{} {}`, `{"v":9223372036854775808}`} {
		if _, err := CanonicalLibraryJSON([]byte(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	if _, err := CanonicalLibraryJSON([]byte(`{"v":"\ud83d\ude00"}`)); err != nil {
		t.Fatal(err)
	}
}
func TestLibraryPathsAndUnknownRecords(t *testing.T) {
	for _, path := range []string{"/a", "a//b", "a/../b", "a/./b", "C:/x", "a\\b", "a/\x00", "cafe\u0301.md"} {
		if ValidateLibraryPath(path) == nil {
			t.Fatalf("accepted %q", path)
		}
	}
	e := vectorEntry("one")
	e.SchemaVersion = 2
	if _, err := e.ComputeContentHash(); err == nil {
		t.Fatal("unknown schema accepted")
	}
	e.SchemaVersion = 1
	e.Kind = "unknown"
	if _, err := e.ComputeContentHash(); err == nil {
		t.Fatal("unknown kind accepted")
	}
	e = vectorEntry("one")
	e.Files = append(e.Files, LibraryFile{Path: "RULES/Review.md", SHA256: e.Files[0].SHA256, SizeBytes: 3, Mode: "text"})
	if _, err := e.ComputeContentHash(); err == nil {
		t.Fatal("case folded duplicate accepted")
	}
}

func TestLibraryCompleteSnapshotGoldenVector(t *testing.T) {
	snapshot := LibrarySnapshot{SchemaVersion: 1, SnapshotID: "snap_1", SessionID: "sess_1", ProjectID: "", ProjectRevision: 0, ProjectContextDigest: strings.Repeat("a", 64), Role: ProjectContextRoleWorker, Channel: SessionModeTUI, RegistryRevision: 3, TrustEpoch: 2, OwnedSnapshotRef: "session-library://sess_1", ProviderID: "codex", AdapterID: "inert-library-v1", AdapterVersion: "1", CreatedAt: "2026-10-22T12:00:00.000Z", Entries: []LibrarySnapshotEntry{}, Warnings: []string{}}
	hash, err := snapshot.ComputeDigest()
	if err != nil {
		t.Fatal(err)
	}
	const want = "sha256:6176174b896ca1146d32212008077fd85ca1c8f716a8ec1af79b8df277abbbc3"
	if hash != want {
		t.Fatalf("hash=%s want=%s", hash, want)
	}
	snapshot.SnapshotDigest = hash
	if err := snapshot.VerifyDigest(); err != nil {
		t.Fatal(err)
	}
	snapshot.ProviderID = "other"
	if snapshot.VerifyDigest() == nil {
		t.Fatal("snapshot mutation accepted")
	}
}
