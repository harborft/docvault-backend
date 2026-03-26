const express  = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const logger   = require('../utils/logger');

const router = express.Router();

// ── POST /api/auth/register-client
// Admin creates a new client portal user
router.post('/register-client', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, password, full_name, company_name, client_id } = req.body;

    if (!email || !password || !full_name || !client_id) {
      return res.status(400).json({ error: 'email, password, full_name, and client_id are required' });
    }

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
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/invite
// Send a magic link invite to an existing or new client email
router.post('/invite', requireAuth, requireAdmin, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/auth/me
// Return current user's profile + linked client info
router.get('/me', requireAuth, async (req, res) => {
  try {
    let clientInfo = null;

    if (req.profile.role === 'client') {
      const { data } = await supabase
        .from('client_users')
        .select('clients(*)')
        .eq('user_id', req.user.id)
        .single();
      clientInfo = data?.clients || null;
    }

    const { data: unreadCount } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('read', false);

    res.json({
      user:    req.user,
      profile: req.profile,
      client:  clientInfo,
      unread_notifications: unreadCount || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
