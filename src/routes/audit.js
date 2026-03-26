// routes/audit.js
const express  = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const router   = express.Router();

router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { client_id, document_id, limit = 100, offset = 0 } = req.query;
    let query = supabase
      .from('audit_log')
      .select('*, profiles(full_name), clients(name), documents(original_name)')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (client_id)   query = query.eq('client_id', client_id);
    if (document_id) query = query.eq('document_id', document_id);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ log: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
