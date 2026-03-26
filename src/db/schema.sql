-- DocVault Database Schema
-- Run this once in your Supabase SQL editor to set up all tables

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────
-- USERS (managed by Supabase Auth, extended here)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'client')),
  company_name  TEXT,
  phone         TEXT,
  avatar_url    TEXT,
  mfa_enabled   BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- CLIENTS (companies that upload documents)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  industry      TEXT,
  email         TEXT UNIQUE NOT NULL,
  phone         TEXT,
  address       TEXT,
  portal_active BOOLEAN DEFAULT TRUE,
  storage_used  BIGINT DEFAULT 0,   -- bytes
  storage_limit BIGINT DEFAULT 5368709120, -- 5GB default
  created_by    UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Link users (clients) to their client account
CREATE TABLE IF NOT EXISTS client_users (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, user_id)
);

-- ─────────────────────────────────────────
-- FOLDERS (organized by client)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS folders (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_by  UUID REFERENCES profiles(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Default folders auto-created for each client
CREATE OR REPLACE FUNCTION create_default_folders()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO folders (client_id, name) VALUES
    (NEW.id, 'Bank Statements'),
    (NEW.id, 'Invoices'),
    (NEW.id, 'Tax Documents'),
    (NEW.id, 'Payroll'),
    (NEW.id, 'Contracts'),
    (NEW.id, 'Other');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auto_create_folders
  AFTER INSERT ON clients
  FOR EACH ROW EXECUTE FUNCTION create_default_folders();

-- ─────────────────────────────────────────
-- DOCUMENTS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  folder_id       UUID REFERENCES folders(id) ON DELETE SET NULL,
  uploaded_by     UUID REFERENCES profiles(id),
  file_name       TEXT NOT NULL,
  original_name   TEXT NOT NULL,
  file_type       TEXT NOT NULL,        -- pdf, image, xlsx, etc.
  mime_type       TEXT NOT NULL,
  file_size       BIGINT NOT NULL,      -- bytes
  storage_path    TEXT NOT NULL UNIQUE, -- path in Supabase Storage bucket
  page_count      INTEGER,              -- for PDFs
  upload_source   TEXT DEFAULT 'web' CHECK (upload_source IN ('web', 'mobile', 'mobile_scan')),
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'approved', 'flagged', 'archived')),
  review_note     TEXT,                 -- admin notes on approval/flag
  reviewed_by     UUID REFERENCES profiles(id),
  reviewed_at     TIMESTAMPTZ,
  tags            TEXT[],               -- e.g. ['Q1', '2025', 'tax']
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- DOCUMENT REQUESTS (admin asks client for specific doc)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_requests (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  folder_id     UUID REFERENCES folders(id),
  requested_by  UUID REFERENCES profiles(id),
  title         TEXT NOT NULL,
  description   TEXT,
  due_date      DATE,
  status        TEXT DEFAULT 'open' CHECK (status IN ('open', 'fulfilled', 'cancelled')),
  fulfilled_doc UUID REFERENCES documents(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- AUDIT LOG (every action recorded)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES profiles(id),
  client_id   UUID REFERENCES clients(id),
  document_id UUID REFERENCES documents(id),
  action      TEXT NOT NULL, -- upload, view, download, approve, flag, delete, login, etc.
  metadata    JSONB,         -- extra context
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- NOTIFICATIONS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  type        TEXT NOT NULL, -- document_request, upload, approval, flag
  reference_id UUID,         -- ID of the related record
  read        BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- ROW LEVEL SECURITY (clients only see their data)
-- ─────────────────────────────────────────
ALTER TABLE profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_users      ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications     ENABLE ROW LEVEL SECURITY;

-- Admins can see everything
CREATE POLICY "Admins full access - profiles"
  ON profiles FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    OR id = auth.uid()
  );

CREATE POLICY "Admins full access - clients"
  ON clients FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

CREATE POLICY "Clients see own data - documents"
  ON documents FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    OR
    EXISTS (
      SELECT 1 FROM client_users cu
      WHERE cu.user_id = auth.uid() AND cu.client_id = documents.client_id
    )
  );

CREATE POLICY "Clients can insert own documents"
  ON documents FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM client_users cu
      WHERE cu.user_id = auth.uid() AND cu.client_id = documents.client_id
    )
    OR
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

CREATE POLICY "Admins can update documents"
  ON documents FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

CREATE POLICY "Clients see own folders"
  ON folders FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    OR
    EXISTS (
      SELECT 1 FROM client_users cu
      WHERE cu.user_id = auth.uid() AND cu.client_id = folders.client_id
    )
  );

CREATE POLICY "Clients see own requests"
  ON document_requests FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    OR
    EXISTS (
      SELECT 1 FROM client_users cu
      WHERE cu.user_id = auth.uid() AND cu.client_id = document_requests.client_id
    )
  );

CREATE POLICY "Own notifications only"
  ON notifications FOR ALL
  USING (user_id = auth.uid());

-- ─────────────────────────────────────────
-- INDEXES for performance
-- ─────────────────────────────────────────
CREATE INDEX idx_documents_client_id  ON documents(client_id);
CREATE INDEX idx_documents_status     ON documents(status);
CREATE INDEX idx_documents_created_at ON documents(created_at DESC);
CREATE INDEX idx_audit_log_user_id    ON audit_log(user_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at DESC);
CREATE INDEX idx_notifications_user   ON notifications(user_id, read);

-- ─────────────────────────────────────────
-- AUTO-UPDATE updated_at timestamps
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_updated_at          BEFORE UPDATE ON profiles          FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_clients_updated_at           BEFORE UPDATE ON clients           FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_documents_updated_at         BEFORE UPDATE ON documents         FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_document_requests_updated_at BEFORE UPDATE ON document_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at();
