-- +goose Up

-- Revisions order changes to each row independently of transaction start times,
-- wall clocks, and HTTP response timing. Keep bigint revisions as strings on the
-- wire so JavaScript clients retain the full precision.
CREATE SEQUENCE ao_notification_revision_seq;
ALTER TABLE ao_notifications ADD COLUMN revision BIGINT NOT NULL
    DEFAULT nextval('ao_notification_revision_seq');

-- +goose StatementBegin
CREATE FUNCTION ao_assign_notification_revision() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.revision := nextval('ao_notification_revision_seq');
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER ao_notifications_revision
    BEFORE UPDATE ON ao_notifications
    FOR EACH ROW EXECUTE FUNCTION ao_assign_notification_revision();

-- +goose Down
DROP TRIGGER ao_notifications_revision ON ao_notifications;
DROP FUNCTION ao_assign_notification_revision();
ALTER TABLE ao_notifications DROP COLUMN revision;
DROP SEQUENCE ao_notification_revision_seq;
