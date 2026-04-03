-- DocVault Database Schema
-- Run this once in your Supabase SQL editor to set up all tables
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- ─────────────────────────────────────────
-- USERS (managed by Supabase Auth, extended here)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN (
      'owner',
      'manager',
      'staff_accountant',
      'readonly_reviewer',
      'client'
    )
  ),
  company_name TEXT,
  phone TEXT,
  avatar_url TEXT,
  mfa_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- ─────────────────────────────────────────
-- CLIENTS (companies that upload documents)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  industry TEXT,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  address TEXT,
  portal_active BOOLEAN DEFAULT TRUE,
  storage_used BIGINT DEFAULT 0,
  -- bytes
  storage_limit BIGINT DEFAULT 5368709120,
  -- 5GB default
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Link users (clients) to their client account
CREATE TABLE IF NOT EXISTS client_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, user_id)
);
-- ─────────────────────────────────────────
-- FOLDERS (organized by client)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Default folders auto-created for each client
CREATE OR REPLACE FUNCTION create_default_folders() RETURNS TRIGGER AS $$ BEGIN
INSERT INTO folders (client_id, name)
VALUES (NEW.id, 'Bank Statements'),
  (NEW.id, 'Invoices'),
  (NEW.id, 'Tax Documents'),
  (NEW.id, 'Payroll'),
  (NEW.id, 'Contracts'),
  (NEW.id, 'Other');
RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS auto_create_folders ON clients;
CREATE TRIGGER auto_create_folders
AFTER
INSERT ON clients FOR EACH ROW EXECUTE FUNCTION create_default_folders();
-- ─────────────────────────────────────────
-- DOCUMENTS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES folders(id) ON DELETE
  SET NULL,
    uploaded_by UUID REFERENCES profiles(id),
    file_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    -- pdf, image, xlsx, etc.
    mime_type TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    -- bytes
    storage_path TEXT NOT NULL UNIQUE,
    -- OneDrive/SharePoint item ID
    onedrive_web_url TEXT,
    -- SharePoint web URL for admin reference
    onedrive_path TEXT,
    -- e.g. "Clients/Acme Corp/Bank Statements"
    page_count INTEGER,
    -- for PDFs
    upload_source TEXT DEFAULT 'web' CHECK (
      upload_source IN ('web', 'mobile', 'mobile_scan')
    ),
    status TEXT DEFAULT 'pending' CHECK (
      status IN (
        'pending',
        'in_review',
        'approved',
        'flagged',
        'archived'
      )
    ),
    review_note TEXT,
    -- admin notes on approval/flag
    reviewed_by UUID REFERENCES profiles(id),
    reviewed_at TIMESTAMPTZ,
    tags TEXT [],
    -- e.g. ['Q1', '2025', 'tax']
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- ─────────────────────────────────────────
-- DOCUMENT REQUESTS (admin asks client for specific doc)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES folders(id),
  requested_by UUID REFERENCES profiles(id),
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'fulfilled', 'cancelled')),
  fulfilled_doc UUID REFERENCES documents(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- ─────────────────────────────────────────
-- AUDIT LOG (every action recorded)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES profiles(id),
  client_id UUID REFERENCES clients(id),
  document_id UUID REFERENCES documents(id),
  action TEXT NOT NULL,
  -- upload, view, download, approve, flag, delete, login, etc.
  metadata JSONB,
  -- extra context
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- ─────────────────────────────────────────
-- NOTIFICATIONS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL,
  -- document_request, upload, approval, flag
  reference_id UUID,
  -- ID of the related record
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- ─────────────────────────────────────────
-- STAFF ↔ CLIENT ASSIGNMENTS
-- Maps internal staff to specific clients. Owner bypasses this.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_client_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, client_id)
);
-- ─────────────────────────────────────────
-- PENDING ACTIONS QUEUE
-- Staff accountants propose actions; owner/manager approve.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requested_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (
    action_type IN (
      'flag_document',
      'request_upload',
      'create_folder'
    )
  ),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE
  SET NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by UUID REFERENCES profiles(id),
    review_note TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- ─────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_client_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_actions ENABLE ROW LEVEL SECURITY;
-- Helper: check role membership
CREATE OR REPLACE FUNCTION is_role(allowed_roles TEXT []) RETURNS BOOLEAN AS $$
SELECT EXISTS (
    SELECT 1
    FROM profiles
    WHERE id = auth.uid()
      AND role = ANY(allowed_roles)
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;
-- Helper: check access to a specific client
CREATE OR REPLACE FUNCTION has_client_access(target_client_id UUID) RETURNS BOOLEAN AS $$
SELECT EXISTS (
    SELECT 1
    FROM profiles
    WHERE id = auth.uid()
      AND role = 'owner'
  )
  OR EXISTS (
    SELECT 1
    FROM staff_client_assignments
    WHERE user_id = auth.uid()
      AND client_id = target_client_id
  )
  OR EXISTS (
    SELECT 1
    FROM client_users
    WHERE user_id = auth.uid()
      AND client_id = target_client_id
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;
-- ── Profiles
DROP POLICY IF EXISTS "profiles_select" ON profiles;
CREATE POLICY "profiles_select" ON profiles FOR
SELECT USING (
    is_role(ARRAY ['owner'])
    OR id = auth.uid()
    OR (
      is_role(
        ARRAY ['manager','staff_accountant','readonly_reviewer']
      )
      AND role = 'client'
      AND EXISTS (
        SELECT 1
        FROM client_users cu
          JOIN staff_client_assignments sa ON sa.client_id = cu.client_id
        WHERE cu.user_id = profiles.id
          AND sa.user_id = auth.uid()
      )
    )
  );
DROP POLICY IF EXISTS "profiles_modify" ON profiles;
CREATE POLICY "profiles_modify" ON profiles FOR ALL USING (
  is_role(ARRAY ['owner'])
  OR id = auth.uid()
);
-- ── Clients
DROP POLICY IF EXISTS "clients_select" ON clients;
CREATE POLICY "clients_select" ON clients FOR
SELECT USING (has_client_access(id));
DROP POLICY IF EXISTS "clients_insert" ON clients;
CREATE POLICY "clients_insert" ON clients FOR
INSERT WITH CHECK (is_role(ARRAY ['owner']));
DROP POLICY IF EXISTS "clients_update" ON clients;
CREATE POLICY "clients_update" ON clients FOR
UPDATE USING (
    is_role(ARRAY ['owner'])
    OR (
      is_role(ARRAY ['manager'])
      AND has_client_access(id)
    )
  );
-- ── Documents
DROP POLICY IF EXISTS "documents_select" ON documents;
CREATE POLICY "documents_select" ON documents FOR
SELECT USING (has_client_access(client_id));
DROP POLICY IF EXISTS "documents_insert" ON documents;
CREATE POLICY "documents_insert" ON documents FOR
INSERT WITH CHECK (
    has_client_access(client_id)
    AND NOT is_role(ARRAY ['readonly_reviewer'])
  );
DROP POLICY IF EXISTS "documents_update" ON documents;
CREATE POLICY "documents_update" ON documents FOR
UPDATE USING (is_role(ARRAY ['owner','manager']));
-- ── Folders
DROP POLICY IF EXISTS "folders_select" ON folders;
CREATE POLICY "folders_select" ON folders FOR
SELECT USING (has_client_access(client_id));
DROP POLICY IF EXISTS "folders_insert" ON folders;
CREATE POLICY "folders_insert" ON folders FOR
INSERT WITH CHECK (is_role(ARRAY ['owner','manager']));
-- ── Document Requests
DROP POLICY IF EXISTS "requests_select" ON document_requests;
CREATE POLICY "requests_select" ON document_requests FOR
SELECT USING (has_client_access(client_id));
DROP POLICY IF EXISTS "requests_insert" ON document_requests;
CREATE POLICY "requests_insert" ON document_requests FOR
INSERT WITH CHECK (is_role(ARRAY ['owner','manager']));
DROP POLICY IF EXISTS "requests_update" ON document_requests;
CREATE POLICY "requests_update" ON document_requests FOR
UPDATE USING (has_client_access(client_id));
-- ── Audit Log
DROP POLICY IF EXISTS "audit_select" ON audit_log;
CREATE POLICY "audit_select" ON audit_log FOR
SELECT USING (
    is_role(ARRAY ['owner'])
    OR has_client_access(client_id)
  );
DROP POLICY IF EXISTS "audit_insert" ON audit_log;
CREATE POLICY "audit_insert" ON audit_log FOR
INSERT WITH CHECK (true);
-- ── Notifications
DROP POLICY IF EXISTS "notifications_own" ON notifications;
CREATE POLICY "notifications_own" ON notifications FOR ALL USING (user_id = auth.uid());
-- ── Staff Client Assignments
DROP POLICY IF EXISTS "assignments_select" ON staff_client_assignments;
CREATE POLICY "assignments_select" ON staff_client_assignments FOR
SELECT USING (
    is_role(ARRAY ['owner'])
    OR user_id = auth.uid()
  );
DROP POLICY IF EXISTS "assignments_modify" ON staff_client_assignments;
CREATE POLICY "assignments_modify" ON staff_client_assignments FOR ALL USING (is_role(ARRAY ['owner']));
-- ── Pending Actions
DROP POLICY IF EXISTS "pending_actions_select" ON pending_actions;
CREATE POLICY "pending_actions_select" ON pending_actions FOR
SELECT USING (
    is_role(ARRAY ['owner','manager'])
    OR requested_by = auth.uid()
  );
DROP POLICY IF EXISTS "pending_actions_insert" ON pending_actions;
CREATE POLICY "pending_actions_insert" ON pending_actions FOR
INSERT WITH CHECK (requested_by = auth.uid());
DROP POLICY IF EXISTS "pending_actions_update" ON pending_actions;
CREATE POLICY "pending_actions_update" ON pending_actions FOR
UPDATE USING (is_role(ARRAY ['owner','manager']));
-- ─────────────────────────────────────────
-- INDEXES for performance
-- ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_documents_client_id ON documents(client_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_staff_assignments_user ON staff_client_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_staff_assignments_client ON staff_client_assignments(client_id);
CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status);
CREATE INDEX IF NOT EXISTS idx_pending_actions_requested ON pending_actions(requested_by);
CREATE INDEX IF NOT EXISTS idx_pending_actions_client ON pending_actions(client_id);
-- ─────────────────────────────────────────
-- AUTO-UPDATE updated_at timestamps
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW();
RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_profiles_updated_at ON profiles;
CREATE TRIGGER trg_profiles_updated_at BEFORE
UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_clients_updated_at ON clients;
CREATE TRIGGER trg_clients_updated_at BEFORE
UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_documents_updated_at ON documents;
CREATE TRIGGER trg_documents_updated_at BEFORE
UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_document_requests_updated_at ON document_requests;
CREATE TRIGGER trg_document_requests_updated_at BEFORE
UPDATE ON document_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_pending_actions_updated_at ON pending_actions;
CREATE TRIGGER trg_pending_actions_updated_at BEFORE
UPDATE ON pending_actions FOR EACH ROW EXECUTE FUNCTION update_updated_at();