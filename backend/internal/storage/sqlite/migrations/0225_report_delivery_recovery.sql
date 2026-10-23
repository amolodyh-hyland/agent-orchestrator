-- +goose Up
CREATE TABLE report_delivery_resolutions (
    batch_id TEXT PRIMARY KEY,
    resolution TEXT NOT NULL CHECK (resolution IN ('held', 'delivered_elsewhere')),
    note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 1000),
    resolved_at TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO report_chat_deliveries(batch_id, message_id, client_message_id, conversation_id, turn_id, provider_turn_id, provider_conversation_id, accepted_at)
SELECT DISTINCT r.delivery_batch_id, m.id, m.client_message_id, t.conversation_id, t.id, t.provider_turn_id, s.provider_conversation_id,
 (SELECT min(e.received_at) FROM conversation_provider_events e
  WHERE e.conversation_id=t.conversation_id AND e.session_id=t.handled_by_session_id
    AND e.method='turn.started' AND t.provider_turn_id<>''
    AND json_extract(e.payload_json,'$.providerTurnId')=t.provider_turn_id
    AND s.provider_conversation_id<>'' AND json_extract(e.payload_json,'$.providerConversationId')=s.provider_conversation_id
    AND s.harness='codex' AND json_type(e.payload_json,'$.nativeAcceptance') IS NULL)
FROM reports r
JOIN conversation_messages m ON m.client_message_id = r.delivery_batch_id AND m.role = 'user' AND m.origin = 'automation'
JOIN conversation_turns t ON t.id = m.turn_id
JOIN sessions s ON s.id = t.handled_by_session_id AND s.project_id = r.project_id AND s.kind = 'orchestrator'
WHERE r.delivery_batch_id <> '' AND r.delivery_state IN ('pending', 'claimed')
  AND (SELECT count(*) FROM conversation_messages cm
       JOIN conversation_turns ct ON ct.id = cm.turn_id
       JOIN sessions cs ON cs.id = ct.handled_by_session_id
       WHERE cm.client_message_id = r.delivery_batch_id AND cm.role = 'user' AND cm.origin = 'automation'
         AND cs.project_id = r.project_id AND cs.kind = 'orchestrator') = 1;

UPDATE report_chat_deliveries SET accepted_at = (
    SELECT min(e.received_at) FROM conversation_provider_events e
    JOIN conversation_turns t ON t.id = report_chat_deliveries.turn_id
    JOIN sessions s ON s.id = t.handled_by_session_id
    WHERE e.conversation_id = t.conversation_id AND e.session_id = t.handled_by_session_id
      AND e.method = 'turn.started' AND t.provider_turn_id <> ''
      AND json_extract(e.payload_json, '$.providerTurnId') = t.provider_turn_id
      AND coalesce(json_extract(e.payload_json, '$.providerConversationId'), '') IN ('', s.provider_conversation_id)
      AND json_extract(e.payload_json, '$.nativeAcceptance') = 1
), provider_turn_id = coalesce((SELECT provider_turn_id FROM conversation_turns WHERE id = report_chat_deliveries.turn_id), ''),
provider_conversation_id = coalesce((SELECT s.provider_conversation_id FROM conversation_turns t JOIN sessions s ON s.id=t.handled_by_session_id WHERE t.id=report_chat_deliveries.turn_id), '')
WHERE accepted_at IS NULL;

UPDATE report_chat_deliveries SET submitted_at=accepted_at
WHERE accepted_at IS NOT NULL AND submitted_at IS NULL;

INSERT INTO report_delivery_resolutions(batch_id,resolution,note,resolved_at)
SELECT r.delivery_batch_id, 'held',
 'Upgrade could not correlate the existing Chat delivery; inspect its transcript and explicitly resolve if delivered elsewhere', coalesce(max(r.claimed_at), min(r.created_at))
FROM reports r WHERE (r.delivery_state='claimed' OR (r.delivery_state='pending' AND r.delivery_attempts>0)) AND r.delivery_batch_id<>''
AND NOT EXISTS (SELECT 1 FROM report_chat_deliveries d WHERE d.batch_id=r.delivery_batch_id)
AND (
 EXISTS (SELECT 1 FROM sessions s WHERE s.project_id=r.project_id AND s.kind='orchestrator' AND s.session_mode='chat')
 OR EXISTS (
  SELECT 1 FROM conversation_messages m
  JOIN conversation_turns t ON t.id=m.turn_id AND t.conversation_id=m.conversation_id
  JOIN sessions s ON s.id=t.handled_by_session_id
  WHERE s.project_id=r.project_id AND s.kind='orchestrator'
    AND m.role='user' AND m.created_at>=r.created_at
    AND instr(m.text,'<ao-worker-reports>')>0 AND instr(m.text,'</ao-worker-reports>')>0
    AND (instr(m.text,coalesce(nullif(r.note,''),nullif(r.message,'')))>0
         OR EXISTS (SELECT 1 FROM report_outputs o WHERE o.report_id=r.id AND instr(m.text,o.reference)>0))
 )
)
GROUP BY r.delivery_batch_id;

-- +goose Down
DROP TABLE report_delivery_resolutions;
