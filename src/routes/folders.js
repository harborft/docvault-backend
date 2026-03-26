// routes/folders.js
const express  = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const router   = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const { client_id } = req.query;
    let query = supabase.from('folders').select('*, documents(count)').order('name');
    if (client_id) query = query.eq('client_id', client_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ folders: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { client_id, name, description } = req.body;
    const { data, error } = await supabase
      .from('folders')
      .insert({ client_id, name, description, created_by: req.user.id })
      .select().single();
    if (error) throw error;
    res.status(201).json({ folder: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
