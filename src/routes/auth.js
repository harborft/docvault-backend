const express  = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const logger   = require('../utils/logger');
const { scopeToAssigned } = require('../utils/scope');
const { validate, registerClientBody, inviteBody } = require('../utils/validation');

const router = express.Router();

// ── POST /api/auth/register-client
// Admin creates a new client portal user
router.post('/register-client', requireAuth, requireRole('owner'), validate(registerClientBody), async (req, res) => {
  try {
    const { email, password, full_name, company_name, client_id } = req.body;

    // Create auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name, company_name }
    });

    if (authError) return res.status(400).json({ error: authError.message });

    // Create profile
    const { error: profileError } = await supabase.from('profiles').insert({
      id:           authData.user.id,
      full_name,
      role:         'client',
      company_name
    });
    if (profileError) throw profileError;

    // Link user to client account
    const { error: linkError } = await supabase.from('client_users').insert({
      client_id,
      user_id: authData.user.id
    });
    if (linkError) throw linkError;

    // Send welcome / portal invite email via Supabase
    await supabase.auth.admin.generateLink({
      type:  'magiclink',
      email,
      options: { redirectTo: `${process.env.FRONTEND_URL}/portal` }
    });

    await logAction({ userId: req.user.id, clientId: client_id, action: 'create_client_user', req });

    res.status(201).json({ message: 'Client user created and invite sent', userId: authData.user.id });
  } catch (err) {
    logger.error('Register client error', { error: err.message });
    res.status(500).json({ error: 'Failed to register client user' });
  }
});

// ── POST /api/auth/invite
// Send a magic link invite to an existing or new client email
router.post('/invite', requireAuth, requireRole('owner'), validate(inviteBody), async (req, res) => {
  try {
    const { email } = req.body;
    const { data, error } = await supabase.auth.admin.generateLink({
      type:  'magiclink',
      email,
      options: { redirectTo: `${process.env.FRONTEND_URL}/portal` }
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Invite sent', link: data.properties?.action_link });
  } catch (err) {
    logger.error('Invite error', { error: err.message });
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// ── GET /api/auth/me
// Return current user's profile + linked client info + assigned clients for staff
router.get('/me', requireAuth, async (req, res) => {
  try {
    const role = req.profile.role;
    let clientInfo        = null;
    let assignedClients   = null;

    if (role === 'client') {
      const { data } = await supabase
        .from('client_users')
        .select('clients(*)')
        .eq('user_id', req.user.id)
        .single();
      clientInfo = data?.clients || null;
    } else if (role !== 'owner') {
      // manager, staff_accountant, readonly_reviewer — return assigned clients
      const { data } = await supabase
        .from('staff_client_assignments')
        .select('clients(id, name)')
        .eq('user_id', req.user.id);
      assignedClients = data?.map(r => r.clients) || [];
    }

    const { count: unreadCount } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('read', false);

    // Build permissions map so the frontend knows what this role can do
    const permissions = {
      canManageUsers:     role === 'owner',
      canManageClients:   role === 'owner',
      canApproveDocuments:['owner', 'manager'].includes(role),
      canCreateRequests:  ['owner', 'manager'].includes(role),
      canUpload:          role !== 'readonly_reviewer',
      canDownload:        role !== 'client' || true, // all roles can download their scoped data
      canViewAudit:       ['owner', 'manager'].includes(role),
      canFlagDocuments:   ['owner', 'manager', 'staff_accountant'].includes(role),
    };

    res.json({
      user:    req.user,
      profile: req.profile,
      client:  clientInfo,
      assigned_clients:    assignedClients,
      permissions,
      unread_notifications: unreadCount || 0
    });
  } catch (err) {
    logger.error('Get profile error', { error: err.message });
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ── GET /api/auth/notifications
router.get('/notifications', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) throw error;
    res.json({ notifications: data });
  } catch (err) {
    logger.error('Notifications error', { error: err.message });
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// ── PATCH /api/auth/notifications/read-all
router.patch('/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', req.user.id);
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    logger.error('Mark notifications read error', { error: err.message });
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

module.exports = router;
