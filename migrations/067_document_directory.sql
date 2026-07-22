-- ===========================================================
-- 067 - Document Directory
-- ===========================================================
-- Standalone Admin module for securely storing, viewing,
-- downloading and sharing business documents. Binary content
-- is written to disk under uploads/private/documents/ - this
-- table stores metadata + the relative storage path.
--
-- No related tables (share history / email queue / audit logs)
-- are created intentionally: email sending is runtime-only per
-- the spec, so nothing about a share is persisted.
--
-- document_id is a human-facing identifier in the form
--   DOC-YY-<7 alnum> (e.g. DOC-26-A7KD92F)
-- generated in the service layer with a uniqueness re-try loop.
-- ===========================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id       VARCHAR(32)  NOT NULL,
  document_name     VARCHAR(255) NOT NULL,
  description       TEXT         NULL,
  category          VARCHAR(100) NULL,
  tags              VARCHAR(500) NULL,
  original_filename VARCHAR(500) NOT NULL,
  stored_filename   VARCHAR(255) NOT NULL,
  extension         VARCHAR(32)  NULL,
  mime_type         VARCHAR(255) NULL,
  file_size         BIGINT UNSIGNED NOT NULL DEFAULT 0,
  storage_path      VARCHAR(500) NOT NULL,
  uploaded_by       BIGINT UNSIGNED NULL,
  status            ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_documents_document_id (document_id),
  KEY ix_documents_created_at (created_at),
  KEY ix_documents_status     (status),
  KEY ix_documents_extension  (extension),
  KEY ix_documents_name       (document_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
