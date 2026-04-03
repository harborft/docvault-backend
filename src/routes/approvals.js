// routes/approvals.js
const express  = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const logger   = require('../utils/logger');
const { scopeToAssigned, getAssignedClientIds } = require('../utils/scope');
const router   = express.Router();

// Pending documents — scoped to assigned clients for non-owners
router.get('/', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  try {
    let query = supabase
      .from('documents')
      .select('*, clients(name), folders(name), profiles!uploaded_by(full_name)')
      .in('status', ['pending', 'in_review', 'flagged'])
      .order('created_at', { ascending: false });
    query = await scopeToAssigned(query, req.user.id, req.profile.role);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ documents: data });
  } catch (err) { logger.error('List approvals error', { error: err.message }); res.status(500).json({ error: 'Failed to list pending documents' }); }
});

// Stats for dashboard — scoped to assigned clients for non-owners
router.get('/stats', requireAuth, requireRole('owner', 'manager'), async (req, res) => {
  try {
    const clientIds = await getAssignedClientIds(req.user.id, req.profile.role);
    const addScope = (q) => clientIds ? q.in('client_id', clientIds) : q;

    const [pending, approved, flagged, total] = await Promise.all([
      addScope(supabase.from('documents').select('id', { count: 'exact', head: true }).eq('status', 'pending')),
      addScope(supabase.from('documents').select('id', { count: 'exact', head: true }).eq('status', 'approved')),
      addScope(supabase.from('documents').select('id', { count: 'exact', head: true }).eq('status', 'flagged')),
      addScope(supabase.from('documents').select('id', { count: 'exact', head: true }))
    ]);
    res.json({
      pending:  pending.count  || 0,
      approved: approved.count || 0,
      flagged:  flagged.count  || 0,
      total:    total.count    || 0
    });
  } catch (err) { logger.error('Approval stats error', { error: err.message }); res.status(500).json({ error: 'Failed to load stats' }); }
});

module.exports = router;
