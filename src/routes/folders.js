// routes/folders.js
const express  = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const logger   = require('../utils/logger');
const { scopeToAssigned } = require('../utils/scope');
const { validate, validateQuery, createFolderBody, folderListQuery } = require('../utils/validation');
const router   = express.Router();

// All roles can list folders — scoped to their assigned clients
router.get('/', requireAuth, validateQuery(folderListQuery), async (req, res) => {
  try {
    const { client_id } = req.query;
    let query = supabase.from('folders').select('*, documents(count)').order('name');
    if (client_id) query = query.eq('client_id', client_id);
    query = await scopeToAssigned(query, req.user.id, req.profile.role);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ folders: data });
  } catch (err) { logger.error('List folders error', { error: err.message }); res.status(500).json({ error: 'Failed to list folders' }); }
});

// Owner and manager can create folders directly
router.post('/', requireAuth, requireRole('owner', 'manager'), validate(createFolderBody), async (req, res) => {
  try {
    const { client_id, name, description } = req.body;
    const { data, error } = await supabase
      .from('folders')
      .insert({ client_id, name, description, created_by: req.user.id })
      .select().single();
    if (error) throw error;
    res.status(201).json({ folder: data });
  } catch (err) { logger.error('Create folder error', { error: err.message }); res.status(500).json({ error: 'Failed to create folder' }); }
});

module.exports = router;
