-- OneDrive Integration Migration
-- Run this in your Supabase SQL editor AFTER the main schema.sql
-- It adds two new columns to the documents table to store OneDrive references.
--
-- storage_path     = already exists — we repurpose it to hold the OneDrive item ID
-- onedrive_web_url = new — the human-readable SharePoint URL (for manual access)
-- onedrive_path    = new — the folder path, e.g. "Clients/Acme Corp/Bank Statements"

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS onedrive_web_url TEXT,
  ADD COLUMN IF NOT EXISTS onedrive_path    TEXT;

-- Optional: add a comment so future devs know what storage_path means now
COMMENT ON COLUMN documents.storage_path IS
  'OneDrive/SharePoint item ID (used by Microsoft Graph API for downloads)';

COMMENT ON COLUMN documents.onedrive_web_url IS
  'Direct SharePoint web URL — for admin reference only, not used for downloads';

COMMENT ON COLUMN documents.onedrive_path IS
  'Human-readable folder path in SharePoint, e.g. Clients/Acme Corp/Bank Statements';
