-- Internal full-text search index foundation (Phase 3). No query service, ranking or API uses it yet.
-- One immutable search document per (contribution_id, version). The document keeps unindexed identity
-- (id, exact version, family, content type) beside the deterministic `indexed_text` built in TypeScript.
-- The FTS5 table is an external-content index over the document table, kept in sync by an insert trigger;
-- documents are never updated or deleted, so earlier versions stay searchable and unchanged.
-- Databases created through repository migrations only: there is no backfill for pre-existing versions.

CREATE TABLE contribution_search_documents (
  doc_id          INTEGER PRIMARY KEY,
  contribution_id TEXT NOT NULL,
  version         INTEGER NOT NULL CHECK (version >= 1),
  family          TEXT NOT NULL CHECK (family IN ('knowledge', 'execution')),
  content_type    TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 100),
  indexed_text    TEXT NOT NULL CHECK (length(indexed_text) > 0),
  UNIQUE (contribution_id, version),
  FOREIGN KEY (contribution_id, version, family)
    REFERENCES contribution_versions (contribution_id, version, family) ON DELETE RESTRICT
) STRICT;

CREATE VIRTUAL TABLE contribution_search USING fts5(
  indexed_text,
  content = 'contribution_search_documents',
  content_rowid = 'doc_id',
  tokenize = 'unicode61'
);

CREATE TRIGGER contribution_search_documents_index AFTER INSERT ON contribution_search_documents
BEGIN
  INSERT INTO contribution_search (rowid, indexed_text) VALUES (new.doc_id, new.indexed_text);
END;
CREATE TRIGGER contribution_search_documents_no_update BEFORE UPDATE ON contribution_search_documents
BEGIN SELECT RAISE(ABORT, 'search documents are immutable'); END;
CREATE TRIGGER contribution_search_documents_no_delete BEFORE DELETE ON contribution_search_documents
BEGIN SELECT RAISE(ABORT, 'search documents cannot be deleted'); END;
