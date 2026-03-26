// routes/approvals.js
const express  = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const router   = express.Router();

// All pending documents, newest first
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('*, clients(name), folders(name), profiles!uploaded_by(full_name)')
      .in('status', ['pending', 'in_review', 'flagged'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ documents: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stats for dashboard
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [pending, approved, flagged, total] = await Promise.all([
      supabase.from('documents').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('documents').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
      supabase.from('documents').select('id', { count: 'exact', head: true }).eq('status', 'flagged'),
      supabase.from('documents').select('id', { count: 'exact', head: true })
    ]);
    res.json({
      pending:  pending.count  || 0,
      approved: approved.count || 0,
      flagged:  flagged.count  || 0,
      total:    total.count    || 0
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
