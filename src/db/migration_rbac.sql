-- ═══════════════════════════════════════════════════════════════════════════════
-- RBAC Migration: 2-role → 5-role permission system
-- Run this in your Supabase SQL editor AFTER schema.sql and migration_onedrive.sql
--
-- Roles:
--   owner             – full system access, user management
--   manager           – approve docs, manage assigned clients
--   staff_accountant  – view/download assigned clients, flag for review (pending queue)
--   readonly_reviewer – view/download only on assigned clients
--   client            – own portal only (unchanged)
-- ═══════════════════════════════════════════════════════════════════════════════
-- ─────────────────────────────────────────
-- 1. Expand the profiles.role CHECK constraint
-- ─────────────────────────────────────────
-- Drop existing constraint, migrate data, THEN add expanded one
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
-- Migrate existing admin users → owner (BEFORE adding new constraint)
UPDATE profiles
SET role = 'owner'
WHERE role = 'admin';
ALTER TABLE profiles
ADD CONSTRAINT profiles_role_check CHECK (
        role IN (
            'owner',
            'manager',
            'staff_accountant',
            'readonly_reviewer',
            'client'
        )
    );
-- ─────────────────────────────────────────
-- 2. Staff ↔ Client assignment table
--    Maps internal staff (owner/manager/staff/reviewer) to specific clients.
--    Owner bypasses this — they see everything.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_client_assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    assigned_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_staff_assignments_user ON staff_client_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_staff_assignments_client ON staff_client_assignments(client_id);
-- ─────────────────────────────────────────
-- 3. Pending actions queue
--    Staff accountants submit actions here; owner/manager approve them.
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
    -- What entity the action targets
    client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
    document_id UUID REFERENCES documents(id) ON DELETE
    SET NULL,
        -- Payload stores the action details (e.g. flag reason, request title/description)
        payload JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        reviewed_by UUID REFERENCES profiles(id),
        review_note TEXT,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status);
CREATE INDEX IF NOT EXISTS idx_pending_actions_requested ON pending_actions(requested_by);
CREATE INDEX IF NOT EXISTS idx_pending_actions_client ON pending_actions(client_id);
-- Auto-update updated_at for pending_actions
DROP TRIGGER IF EXISTS trg_pending_actions_updated_at ON pending_actions;
CREATE TRIGGER trg_pending_actions_updated_at BEFORE
UPDATE ON pending_actions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
-- ─────────────────────────────────────────
-- 4. Enable RLS on new tables
-- ─────────────────────────────────────────
ALTER TABLE staff_client_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_actions ENABLE ROW LEVEL SECURITY;
-- ─────────────────────────────────────────
-- 5. Drop old RLS policies and create new ones
--    Uses a helper function to check role hierarchy.
-- ─────────────────────────────────────────
-- Helper: check if current user is internal staff with any of the given roles
CREATE OR REPLACE FUNCTION is_role(allowed_roles TEXT []) RETURNS BOOLEAN AS $$
SELECT EXISTS (
        SELECT 1
        FROM profiles
        WHERE id = auth.uid()
            AND role = ANY(allowed_roles)
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;
-- Helper: check if current user is assigned to a specific client (or is owner)
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
-- ── Drop all old AND new policies (safe for re-runs) ──
DROP POLICY IF EXISTS "Admins full access - profiles" ON profiles;
DROP POLICY IF EXISTS "Admins full access - clients" ON clients;
DROP POLICY IF EXISTS "Clients see own data - documents" ON documents;
DROP POLICY IF EXISTS "Clients can insert own documents" ON documents;
DROP POLICY IF EXISTS "Admins can update documents" ON documents;
DROP POLICY IF EXISTS "Clients see own folders" ON folders;
DROP POLICY IF EXISTS "Clients see own requests" ON document_requests;
DROP POLICY IF EXISTS "Own notifications only" ON notifications;
DROP POLICY IF EXISTS "profiles_select" ON profiles;
DROP POLICY IF EXISTS "profiles_modify" ON profiles;
DROP POLICY IF EXISTS "clients_select" ON clients;
DROP POLICY IF EXISTS "clients_insert" ON clients;
DROP POLICY IF EXISTS "clients_update" ON clients;
DROP POLICY IF EXISTS "documents_select" ON documents;
DROP POLICY IF EXISTS "documents_insert" ON documents;
DROP POLICY IF EXISTS "documents_update" ON documents;
DROP POLICY IF EXISTS "folders_select" ON folders;
DROP POLICY IF EXISTS "folders_insert" ON folders;
DROP POLICY IF EXISTS "requests_select" ON document_requests;
DROP POLICY IF EXISTS "requests_insert" ON document_requests;
DROP POLICY IF EXISTS "requests_update" ON document_requests;
DROP POLICY IF EXISTS "audit_select" ON audit_log;
DROP POLICY IF EXISTS "audit_insert" ON audit_log;
DROP POLICY IF EXISTS "notifications_own" ON notifications;
DROP POLICY IF EXISTS "assignments_select" ON staff_client_assignments;
DROP POLICY IF EXISTS "assignments_modify" ON staff_client_assignments;
DROP POLICY IF EXISTS "pending_actions_select" ON pending_actions;
DROP POLICY IF EXISTS "pending_actions_insert" ON pending_actions;
DROP POLICY IF EXISTS "pending_actions_update" ON pending_actions;
-- ── Profiles ──
CREATE POLICY "profiles_select" ON profiles FOR
SELECT USING (
        is_role(ARRAY ['owner'])
        OR id = auth.uid()
        OR (
            is_role(
                ARRAY ['manager', 'staff_accountant', 'readonly_reviewer']
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
CREATE POLICY "profiles_modify" ON profiles FOR ALL USING (
    is_role(ARRAY ['owner'])
    OR id = auth.uid()
);
-- ── Clients ──
CREATE POLICY "clients_select" ON clients FOR
SELECT USING (has_client_access(id));
CREATE POLICY "clients_insert" ON clients FOR
INSERT WITH CHECK (is_role(ARRAY ['owner']));
CREATE POLICY "clients_update" ON clients FOR
UPDATE USING (
        is_role(ARRAY ['owner'])
        OR (
            is_role(ARRAY ['manager'])
            AND has_client_access(id)
        )
    );
-- ── Documents ──
CREATE POLICY "documents_select" ON documents FOR
SELECT USING (has_client_access(client_id));
CREATE POLICY "documents_insert" ON documents FOR
INSERT WITH CHECK (
        has_client_access(client_id)
        AND NOT is_role(ARRAY ['readonly_reviewer'])
    );
CREATE POLICY "documents_update" ON documents FOR
UPDATE USING (is_role(ARRAY ['owner', 'manager']));
-- ── Folders ──
CREATE POLICY "folders_select" ON folders FOR
SELECT USING (has_client_access(client_id));
CREATE POLICY "folders_insert" ON folders FOR
INSERT WITH CHECK (is_role(ARRAY ['owner', 'manager']));
-- ── Document Requests ──
CREATE POLICY "requests_select" ON document_requests FOR
SELECT USING (has_client_access(client_id));
CREATE POLICY "requests_insert" ON document_requests FOR
INSERT WITH CHECK (is_role(ARRAY ['owner', 'manager']));
CREATE POLICY "requests_update" ON document_requests FOR
UPDATE USING (has_client_access(client_id));
-- ── Audit Log ──
CREATE POLICY "audit_select" ON audit_log FOR
SELECT USING (
        is_role(ARRAY ['owner'])
        OR has_client_access(client_id)
    );
CREATE POLICY "audit_insert" ON audit_log FOR
INSERT WITH CHECK (true);
-- service role inserts; RLS allows any authenticated insert
-- ── Notifications ──
CREATE POLICY "notifications_own" ON notifications FOR ALL USING (user_id = auth.uid());
-- ── Staff Client Assignments ──
CREATE POLICY "assignments_select" ON staff_client_assignments FOR
SELECT USING (
        is_role(ARRAY ['owner'])
        OR user_id = auth.uid()
    );
CREATE POLICY "assignments_modify" ON staff_client_assignments FOR ALL USING (is_role(ARRAY ['owner']));
-- ── Pending Actions ──
CREATE POLICY "pending_actions_select" ON pending_actions FOR
SELECT USING (
        is_role(ARRAY ['owner', 'manager'])
        OR requested_by = auth.uid()
    );
CREATE POLICY "pending_actions_insert" ON pending_actions FOR
INSERT WITH CHECK (requested_by = auth.uid());
CREATE POLICY "pending_actions_update" ON pending_actions FOR
UPDATE USING (is_role(ARRAY ['owner', 'manager']));