const express  = require('express');
const supabase = require('../config/supabase');
const graph    = require('../config/graph');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const logger   = require('../utils/logger');
const router   = express.Router();

router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('clients').select('*').order('name');
    if (error) throw error;
    res.json({ clients: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, industry, email, phone, address } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });

    const { data: client, error } = await supabase
      .from('clients')
      .insert({ name, industry, email, phone, address, created_by: req.user.id })
      .select().single();
    if (error) throw error;

    // Auto-create OneDrive folders in the background (non-blocking)
    graph.setupClientFolder(name)
      .then(() => logger.info(`OneDrive folders ready for: ${name}`))
      .catch(err => logger.error(`OneDrive folder setup failed: ${name}`, { error: err.message }));

    res.status(201).json({
      client,
      message: `Client created. OneDrive folders being set up at Clients/${name}/`
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clients').select('*, folders(*), document_requests(*)')
      .eq('id', req.params.id).single();
    if (error) throw error;
    res.json({ client: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, industry, phone, address, portal_active } = req.body;
    const { data, error } = await supabase
      .from('clients').update({ name, industry, phone, address, portal_active })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ client: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
