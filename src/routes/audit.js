// routes/audit.js
const express  = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const logger   = require('../utils/logger');
const { scopeToAssigned } = require('../utils/scope');
const { validateQuery, auditListQuery } = require('../utils/validation');
const router   = express.Router();

router.get('/', requireAuth, requireRole('owner', 'manager'), validateQuery(auditListQuery), async (req, res) => {
  try {
    const { client_id, document_id, limit, offset } = req.query;
    let query = supabase
      .from('audit_log')
      .select('*, profiles(full_name), clients(name), documents(original_name)')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (client_id)   query = query.eq('client_id', client_id);
    if (document_id) query = query.eq('document_id', document_id);
    query = await scopeToAssigned(query, req.user.id, req.profile.role);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ log: data });
  } catch (err) { logger.error('Audit log error', { error: err.message }); res.status(500).json({ error: 'Failed to load audit log' }); }
});

module.exports = router;
