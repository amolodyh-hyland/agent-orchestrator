package domain

import (
	"strings"
	"testing"
	"time"
)

func TestProjectContextAttachmentValidate(t *testing.T) {
	valid := ProjectContextAttachment{
		ID:         "guide",
		OwnerKind:  ProjectContextOwnerProject,
		SourceKind: ProjectContextRepoRelativeFile,
		SourceRef:  "source_guide",
		MachineID:  "machine-a",
		MediaType:  "text/markdown",
		Roles:      []ProjectContextRole{ProjectContextRoleShared},
		Enabled:    true,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid attachment: %v", err)
	}

	tests := []struct {
		name    string
		edit    func(*ProjectContextAttachment)
		wantErr string
	}{
		{"empty id", func(a *ProjectContextAttachment) { a.ID = "" }, "attachment id"},
		{"absolute path reference", func(a *ProjectContextAttachment) { a.SourceRef = "/etc/passwd" }, "opaque source reference"},
		{"relative path reference", func(a *ProjectContextAttachment) { a.SourceRef = "../secret.md" }, "opaque source reference"},
		{"backslash path reference", func(a *ProjectContextAttachment) { a.SourceRef = `docs\\secret.md` }, "opaque source reference"},
		{"missing machine id", func(a *ProjectContextAttachment) { a.MachineID = "" }, "machine id"},
		{"oversized source reference", func(a *ProjectContextAttachment) {
			a.SourceRef = strings.Repeat("a", MaxProjectContextSourceReferenceBytes+1)
		}, "source reference is too long"},
		{"missing roles", func(a *ProjectContextAttachment) { a.Roles = nil }, "role scope"},
		{"duplicate role", func(a *ProjectContextAttachment) {
			a.Roles = []ProjectContextRole{ProjectContextRoleShared, ProjectContextRoleShared}
		}, "repeats role"},
		{"unknown role", func(a *ProjectContextAttachment) { a.Roles = []ProjectContextRole{"admin"} }, "unsupported role"},
		{"invalid media type", func(a *ProjectContextAttachment) { a.MediaType = "text" }, "invalid media type"},
		{"negative position", func(a *ProjectContextAttachment) { a.Position = -1 }, "non-negative"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			candidate := valid
			candidate.Roles = append([]ProjectContextRole(nil), valid.Roles...)
			tt.edit(&candidate)
			if err := candidate.Validate(); err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("Validate() error = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestProjectContextAttachmentValidateMachineLocalReference(t *testing.T) {
	attachment := ProjectContextAttachment{
		ID:         "local-runbook",
		OwnerKind:  ProjectContextOwnerUser,
		OwnerID:    "user-library",
		SourceKind: ProjectContextMachineLocalFile,
		SourceRef:  "source_01",
		MachineID:  "h_local_machine",
		MediaType:  "text/plain; charset=utf-8",
		Roles:      []ProjectContextRole{ProjectContextRoleCoordinator, ProjectContextRoleChat},
		Enabled:    true,
	}
	if err := attachment.Validate(); err != nil {
		t.Fatalf("machine-local attachment: %v", err)
	}
	attachment.SourceRef = "/Users/example/runbook.md"
	if err := attachment.Validate(); err == nil {
		t.Fatal("accepted an absolute path as an opaque local source reference")
	}
}

func TestProjectInstructionsValidateBindingCountAndDuplicateIDs(t *testing.T) {
	attachment := ProjectContextAttachment{
		ID: "binding", SourceKind: ProjectContextInlineText, Text: "context", MediaType: "text/plain",
		Roles: []ProjectContextRole{ProjectContextRoleShared}, Enabled: true,
	}
	duplicate := ProjectInstructions{Attachments: []ProjectContextAttachment{attachment, attachment}}
	if err := duplicate.Validate(); err == nil || !strings.Contains(err.Error(), "duplicated") {
		t.Fatalf("duplicate id validation error = %v", err)
	}

	tooMany := ProjectInstructions{Attachments: make([]ProjectContextAttachment, MaxProjectContextBindings+1)}
	for i := range tooMany.Attachments {
		tooMany.Attachments[i] = attachment
		tooMany.Attachments[i].ID = "binding-" + strings.Repeat("x", i+1)
	}
	if err := tooMany.Validate(); err == nil || !strings.Contains(err.Error(), "at most") {
		t.Fatalf("binding count validation error = %v", err)
	}
}

func TestProjectContextManifestDigestDetectsMutation(t *testing.T) {
	manifest := ProjectContextManifest{
		SessionID: "project-1", ProjectID: "project", ProjectRevision: 3,
		Role: ProjectContextRoleWorker, Channel: SessionModeChat, CreatedAt: time.Unix(123, 0).UTC(),
		SharedInstructions: "keep this guidance",
	}
	digest, err := manifest.ComputeDigest()
	if err != nil {
		t.Fatal(err)
	}
	manifest.Digest = digest
	if err := manifest.VerifyDigest(); err != nil {
		t.Fatalf("VerifyDigest(): %v", err)
	}
	manifest.SharedInstructions = "changed"
	if err := manifest.VerifyDigest(); err == nil {
		t.Fatal("VerifyDigest() accepted a changed manifest")
	}
}
