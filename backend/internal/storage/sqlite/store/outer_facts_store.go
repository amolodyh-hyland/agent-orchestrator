package store

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// OuterFacts reads bounded existing report, session or run projections.
func (s *Store) OuterFacts(ctx context.Context, project, kind string, limit int) ([]domain.OuterFact, error) {
	limit = min(max(limit, 1), 50)
	out := []domain.OuterFact{}
	source := func(id string, at time.Time, rev int64) domain.OuterSource {
		return domain.OuterSource{ProjectID: project, Kind: kind, ID: id, Revision: rev, SourceAt: at, ObservedAt: time.Now().UTC(), Sources: []string{project}}
	}
	switch kind {
	case "reports":
		rows, err := s.qr.OuterReportFacts(ctx, gen.OuterReportFactsParams{ProjectID: project, PageSize: int64(limit)})
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			out = append(out, domain.OuterFact{Source: source(r.ID, r.CreatedAt, 0), Summary: r.Note, State: r.State, Receipt: r.DeliveryState + ":" + r.DeliveryBatchID})
		}
	case "sessions":
		projectID := domain.ProjectID(project)
		rows, err := s.qr.OuterSessionFacts(ctx, gen.OuterSessionFactsParams{ProjectID: &projectID, PageSize: int64(limit)})
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			migration, err := s.OuterCallerState(ctx, r.ID)
			if err != nil {
				return nil, err
			}
			out = append(out, domain.OuterFact{CallerState: migration, Source: source(string(r.ID), r.UpdatedAt, r.Revision), Summary: r.DisplayName, State: fmt.Sprintf("%s / %s / %s; terminated=%t", r.Harness, r.SessionMode, r.ActivityState, r.IsTerminated)})
		}
	case "runs":
		rows, err := s.qr.OuterRunFacts(ctx, gen.OuterRunFactsParams{ProjectID: project, PageSize: int64(limit)})
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			out = append(out, domain.OuterFact{Source: source(r.ID, time.Time{}, r.Version), Summary: fmt.Sprint(r.TaskID), State: fmt.Sprint(r.Stage)})
		}
	default:
		return nil, domain.ErrOuterHeld
	}
	return out, nil
}

// OuterSources reads the conservative source history of one native conversation.
func (s *Store) OuterSources(ctx context.Context, conversation string) ([]domain.OuterSource, error) {
	docs, err := s.conversationReader(ctx).ListOuterSources(ctx, conversation)
	if err != nil {
		return nil, err
	}
	out := make([]domain.OuterSource, 0, len(docs))
	for _, doc := range docs {
		var source domain.OuterSource
		if err := json.Unmarshal([]byte(doc), &source); err != nil {
			return nil, err
		}
		out = append(out, source)
	}
	return out, nil
}

// LabelOuterFacts derives labels and transitive known sources under the current scope revision.
func (s *Store) LabelOuterFacts(ctx context.Context, b domain.OuterBinding, conversation string, facts []domain.OuterFact) ([]domain.OuterFact, error) {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return nil, err
	}
	defer s.writeMu.Unlock()
	err := s.inTx(ctx, "label outer facts", func(q *gen.Queries) error {
		doc, err := q.GetOuterBinding(ctx)
		if err != nil {
			return err
		}
		var current domain.OuterBinding
		if err := json.Unmarshal([]byte(doc), &current); err != nil {
			return err
		}
		if current.Revision != b.Revision {
			return domain.ErrOuterHeld
		}
		known, err := q.ListOuterSources(ctx, conversation)
		if err != nil {
			return err
		}
		all := []string{}
		for _, doc := range known {
			var source domain.OuterSource
			if err := json.Unmarshal([]byte(doc), &source); err != nil {
				return err
			}
			all = append(all, source.Sources...)
		}
		for i := range facts {
			f := &facts[i]
			p, err := q.GetProject(ctx, domain.ProjectID(f.Source.ProjectID))
			if err != nil {
				return err
			}
			if p.ArchivedAt.Valid || !slices.Contains(b.ProjectIDs, string(p.ID)) {
				return domain.ErrOuterHeld
			}
			f.Source.Label = p.DisplayName
			if f.Source.Label == "" {
				f.Source.Label = string(p.ID)
			}
			key := f.Source.ProjectID + ":" + f.Source.Kind + ":" + f.Source.ID
			lineage, err := q.OuterSourceLineage(ctx, key)
			if err != nil {
				return err
			}
			f.Source.Sources = append(f.Source.Sources, all...)
			for _, doc := range lineage {
				var source domain.OuterSource
				if err := json.Unmarshal([]byte(doc), &source); err != nil {
					return err
				}
				f.Source.Sources = append(f.Source.Sources, source.Sources...)
				f.Source.Unknown = f.Source.Unknown || source.Unknown
			}
			slices.Sort(f.Source.Sources)
			f.Source.Sources = slices.Compact(f.Source.Sources)
			for _, id := range f.Source.Sources {
				if !slices.Contains(b.ProjectIDs, id) {
					return domain.ErrOuterHeld
				}
			}
			f.Source.Digest = domain.OuterDigest([]any{f.Summary, f.State, f.Receipt, f.Source.Revision, f.CallerState})
			data, err := json.Marshal(f.Source)
			if err != nil {
				return err
			}
			if err := q.UpsertOuterSource(ctx, gen.UpsertOuterSourceParams{ConversationID: conversation, SourceKey: key, Document: string(data)}); err != nil {
				return err
			}
		}
		sources := make([]domain.OuterSource, 0, len(facts))
		for _, f := range facts {
			sources = append(sources, f.Source)
		}
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.read", State: "observed", ProjectID: func() string {
			if len(facts) > 0 {
				return facts[0].Source.ProjectID
			}
			return ""
		}(), SessionID: b.SessionID, Sources: sources})
	})
	return facts, err
}

// RecordOuterEvidence appends inert incoming content and its correlated audit event atomically.
func (s *Store) RecordOuterEvidence(ctx context.Context, id domain.SessionID, content string, source domain.OuterSource) error {
	if len(content) > 65536 {
		content = content[:65536]
	}
	source.Unknown = source.ProjectID == "" || source.Unknown
	data, err := json.Marshal(source)
	if err != nil {
		return err
	}
	key := uuid.NewString()
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "record inert outer evidence", func(q *gen.Queries) error {
		if err := q.InsertOuterEvidence(ctx, gen.InsertOuterEvidenceParams{ID: key, SessionID: string(id), SourceJson: string(data), Content: content, RecordedAt: time.Now().UTC()}); err != nil {
			return err
		}
		return appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "outer.incoming", State: "inert", SessionID: id, ReceiptID: key, Digest: domain.OuterDigest(content), Sources: []domain.OuterSource{source}})
	})
}

// OuterEvidence reads bounded incoming evidence without acknowledging or delivering it.
func (s *Store) OuterEvidence(ctx context.Context, id domain.SessionID) ([]domain.OuterEvidence, error) {
	rows, err := s.qr.ListOuterEvidence(ctx, string(id))
	if err != nil {
		return nil, err
	}
	out := make([]domain.OuterEvidence, 0, len(rows))
	for _, r := range rows {
		var source domain.OuterSource
		if err := json.Unmarshal([]byte(r.SourceJson), &source); err != nil {
			return nil, err
		}
		out = append(out, domain.OuterEvidence{ID: r.ID, SessionID: id, Content: r.Content, Source: source, RecordedAt: r.RecordedAt})
	}
	return out, nil
}
