const express  = require('express');
const supabase = require('../config/supabase');
const graph    = require('../config/graph');
const { requireAuth, requireRole, requireClientAccess } = require('../middleware/auth');
const logger   = require('../utils/logger');
const { scopeToAssigned } = require('../utils/scope');
const { validate, validateParams, idParam, createClientBody, updateClientBody } = require('../utils/validation');
const router   = express.Router();

// List clients — owner sees all, staff sees assigned only
router.get('/', requireAuth, requireRole('owner', 'manager', 'staff_accountant', 'readonly_reviewer'), async (req, res) => {
  try {
    let query = supabase.from('clients').select('*').order('name');
    query = await scopeToAssigned(query, req.user.id, req.profile.role, 'id');
    const { data, error } = await query;
    if (error) throw error;
    res.json({ clients: data });
  } catch (err) { logger.error('List clients error', { error: err.message }); res.status(500).json({ error: 'Failed to list clients' }); }
});

// Create client — owner only
router.post('/', requireAuth, requireRole('owner'), validate(createClientBody), async (req, res) => {
  try {
    const { name, industry, email, phone, address } = req.body;

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
  } catch (err) { logger.error('Create client error', { error: err.message }); res.status(500).json({ error: 'Failed to create client' }); }
});

router.get('/:id', requireAuth, validateParams(idParam), requireClientAccess, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clients').select('*, folders(*), document_requests(*)')
      .eq('id', req.params.id).single();
    if (error) throw error;
    res.json({ client: data });
  } catch (err) { logger.error('Get client error', { error: err.message }); res.status(500).json({ error: 'Failed to load client' }); }
});

// Update client — owner or assigned manager
router.patch('/:id', requireAuth, requireRole('owner', 'manager'), validateParams(idParam), requireClientAccess, validate(updateClientBody), async (req, res) => {
  try {
    const { name, industry, phone, address, portal_active } = req.body;
    const { data, error } = await supabase
      .from('clients').update({ name, industry, phone, address, portal_active })
      .eq('id', req.params.id)
      .select().single();
    if (error) throw error;
    res.json({ client: data });
  } catch (err) { logger.error('Update client error', { error: err.message }); res.status(500).json({ error: 'Failed to update client' }); }
});

module.exports = router;
