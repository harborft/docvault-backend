// routes/requests.js
const express  = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole, INTERNAL_ROLES } = require('../middleware/auth');
const logger   = require('../utils/logger');
const { scopeToAssigned, hasClientAccess } = require('../utils/scope');
const { validate, validateQuery, validateParams, idParam, createRequestBody, fulfillRequestBody, requestListQuery } = require('../utils/validation');
const router   = express.Router();

// List requests — scoped to assigned clients
router.get('/', requireAuth, validateQuery(requestListQuery), async (req, res) => {
  try {
    const { client_id, status } = req.query;
    let query = supabase
      .from('document_requests')
      .select('*, clients(name), folders(name), profiles!requested_by(full_name)')
      .order('created_at', { ascending: false });

    if (client_id) query = query.eq('client_id', client_id);
    query = await scopeToAssigned(query, req.user.id, req.profile.role);

    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ requests: data });
  } catch (err) { logger.error('List requests error', { error: err.message }); res.status(500).json({ error: 'Failed to list requests' }); }
});

// Owner and manager can create document requests
router.post('/', requireAuth, requireRole('owner', 'manager'), validate(createRequestBody), async (req, res) => {
  try {
    const { client_id, folder_id, title, description, due_date } = req.body;

    const { data, error } = await supabase
      .from('document_requests')
      .insert({ client_id, folder_id, title, description, due_date, requested_by: req.user.id })
      .select().single();
    if (error) throw error;

    // Notify client users
    const { data: clientUsers } = await supabase
      .from('client_users').select('user_id').eq('client_id', client_id);
    if (clientUsers?.length) {
      await supabase.from('notifications').insert(
        clientUsers.map(cu => ({
          user_id:      cu.user_id,
          title:        'Document Requested',
          body:         `Your CFO team needs: "${title}"${due_date ? ` — due ${due_date}` : ''}`,
          type:         'document_request',
          reference_id: data.id
        }))
      );
    }

    res.status(201).json({ request: data });
  } catch (err) { logger.error('Create request error', { error: err.message }); res.status(500).json({ error: 'Failed to create request' }); }
});

// Mark a request as fulfilled when client uploads
router.patch('/:id/fulfill', requireAuth, validateParams(idParam), validate(fulfillRequestBody), async (req, res) => {
  try {
    const { document_id } = req.body;

    // Verify the request exists and get its client_id
    const { data: request, error: fetchErr } = await supabase
      .from('document_requests').select('client_id').eq('id', req.params.id).single();
    if (fetchErr || !request) return res.status(404).json({ error: 'Request not found' });

    // Non-owner internal staff must be assigned; clients must belong to the client
    if (req.profile.role !== 'owner') {
      const access = await hasClientAccess(req.user.id, req.profile.role, request.client_id);
      if (!access) return res.status(403).json({ error: 'You do not have access to this request' });
    }

    const { data, error } = await supabase
      .from('document_requests')
      .update({ status: 'fulfilled', fulfilled_doc: document_id })
      .eq('id', req.params.id)
      .select().single();
    if (error) throw error;
    res.json({ request: data });
  } catch (err) { logger.error('Fulfill request error', { error: err.message }); res.status(500).json({ error: 'Failed to fulfill request' }); }
});

module.exports = router;
