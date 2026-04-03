// routes/staff.js
const express  = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole, INTERNAL_ROLES } = require('../middleware/auth');
const logger   = require('../utils/logger');
const { logAction } = require('../utils/audit');
const { validate, validateQuery, validateParams, idParam, registerStaffBody, assignStaffBody, staffListQuery } = require('../utils/validation');
const router   = express.Router();

// List internal staff members (owner only)
router.get('/', requireAuth, requireRole('owner'), validateQuery(staffListQuery), async (req, res) => {
  try {
    const { role } = req.query;
    let query = supabase
      .from('profiles')
      .select('id, full_name, role, created_at')
      .in('role', INTERNAL_ROLES)
      .order('created_at', { ascending: false });
    if (role) query = query.eq('role', role);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ staff: data });
  } catch (err) { logger.error('List staff error', { error: err.message }); res.status(500).json({ error: 'Failed to list staff' }); }
});

// Register a new staff member (owner only)
router.post('/', requireAuth, requireRole('owner'), validate(registerStaffBody), async (req, res) => {
  try {
    const { email, password, full_name, role } = req.body;

    // Create user in Supabase Auth
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name, role },
    });
    if (authErr) throw authErr;

    // Upsert profile
    const { error: profErr } = await supabase.from('profiles').upsert({
      id: authData.user.id,
      full_name,
      role,
    });
    if (profErr) throw profErr;

    await logAction({
      action: 'staff_registered',
      userId: req.user.id,
      metadata: { targetId: authData.user.id, email, role },
    });

    res.status(201).json({ user: { id: authData.user.id, email, full_name, role } });
  } catch (err) { logger.error('Register staff error', { error: err.message }); res.status(500).json({ error: 'Failed to register staff member' }); }
});

// Assign a staff member to a client (owner only)
router.post('/assign', requireAuth, requireRole('owner'), validate(assignStaffBody), async (req, res) => {
  try {
    const { user_id, client_id } = req.body;

    // Verify user is internal staff
    const { data: profile } = await supabase
      .from('profiles').select('role').eq('id', user_id).single();
    if (!profile || !INTERNAL_ROLES.includes(profile.role)) {
      return res.status(400).json({ error: 'User is not an internal staff member' });
    }

    // Verify client exists
    const { data: client } = await supabase
      .from('clients').select('id').eq('id', client_id).single();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { data, error } = await supabase
      .from('staff_client_assignments')
      .insert({ user_id, client_id })
      .select()
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Assignment already exists' });
      throw error;
    }

    await logAction({
      action: 'staff_assigned',
      userId: req.user.id,
      clientId: client_id,
      metadata: { targetId: user_id, role: profile.role },
    });

    res.status(201).json({ assignment: data });
  } catch (err) { logger.error('Assign staff error', { error: err.message }); res.status(500).json({ error: 'Failed to assign staff' }); }
});

// Remove a staff-client assignment (owner only)
router.delete('/assign/:id', requireAuth, requireRole('owner'), validateParams(idParam), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('staff_client_assignments')
      .delete()
      .eq('id', req.params.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Assignment not found' });

    await logAction({
      action: 'staff_unassigned',
      userId: req.user.id,
      clientId: data.client_id,
      metadata: { targetId: data.user_id },
    });

    res.json({ message: 'Assignment removed' });
  } catch (err) { logger.error('Remove assignment error', { error: err.message }); res.status(500).json({ error: 'Failed to remove assignment' }); }
});

// List clients assigned to a staff member (owner only)
router.get('/:id/clients', requireAuth, requireRole('owner'), validateParams(idParam), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('staff_client_assignments')
      .select('id, client_id, clients(name), created_at')
      .eq('user_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ assignments: data });
  } catch (err) { logger.error('Staff clients error', { error: err.message }); res.status(500).json({ error: 'Failed to list staff clients' }); }
});

module.exports = router;
