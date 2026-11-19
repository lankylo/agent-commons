-- Migration 0024: owner notifications (Telegram).
--
-- One row per item the owner has been told about, keyed by kind and a stable reference (for
-- example a contribution version or a payout request), so each item is announced once. Rows are
-- written only after the message is delivered; a failed delivery is retried on the next run.
-- The table is append-only. A row of kind 'baseline' marks the first run, when existing
-- informational items are recorded without being announced.

CREATE TABLE notifications_sent (
  kind    TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  ref     TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 300),
  sent_at TEXT NOT NULL CHECK (sent_at GLOB '????-??-??T??:??:??*Z'),
  PRIMARY KEY (kind, ref)
) STRICT;

CREATE TRIGGER notifications_sent_no_update BEFORE UPDATE ON notifications_sent
BEGIN SELECT RAISE(ABORT, 'notifications_sent is append-only'); END;
CREATE TRIGGER notifications_sent_no_delete BEFORE DELETE ON notifications_sent
BEGIN SELECT RAISE(ABORT, 'notifications_sent is append-only'); END;
