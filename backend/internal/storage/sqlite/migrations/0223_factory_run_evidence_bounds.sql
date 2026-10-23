-- +goose Up
CREATE INDEX factory_run_current_evidence ON factory_run_evidence(run_id,
 CASE
 WHEN json_extract(document, '$.completion.repoName') IS NOT NULL THEN 'completion:' || json_extract(document, '$.completion.repoName')
 WHEN json_extract(document, '$.review.repoName') IS NOT NULL THEN 'review:' || json_extract(document, '$.review.repoName')
 WHEN json_extract(document, '$.kind') = 'created' THEN 'created'
WHEN json_extract(document, '$.kind') = 'advance' THEN 'advance'
 ELSE 'decision' END, version);

-- Bound direct storage admission as well as service/API requests. Existing history
-- remains intact; over-limit legacy runs are read-only until separately archived.
-- +goose StatementBegin
CREATE TRIGGER factory_run_evidence_bounds BEFORE INSERT ON factory_run_evidence BEGIN
 SELECT CASE WHEN length(CAST(NEW.document AS BLOB)) > 262144 OR NEW.version > 511
 THEN RAISE(ABORT, 'run evidence admission limit') END;
END;
-- +goose StatementEnd
-- +goose Down
DROP TRIGGER factory_run_evidence_bounds;
DROP INDEX factory_run_current_evidence;
