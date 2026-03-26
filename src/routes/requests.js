// routes/requests.js
const express  = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const router   = express.Router();

// List requests for a client (or all, if admin)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { client_id, status } = req.query;
    let query = supabase
      .from('document_requests')
      .select('*, clients(name), folders(name), profiles!requested_by(full_name)')
      .order('created_at', { ascending: false });

    if (req.profile.role === 'client') {
      const { data: cu } = await supabase
        .from('client_users').select('client_id').eq('user_id', req.user.id);
      query = query.in('client_id', cu?.map(r => r.client_id) || []);
    } else if (client_id) {
      query = query.eq('client_id', client_id);
    }

    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ requests: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin creates a document request
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { client_id, folder_id, title, description, due_date } = req.body;
    if (!client_id || !title) return res.status(400).json({ error: 'client_id and title required' });

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark a request as fulfilled when client uploads
router.patch('/:id/fulfill', requireAuth, async (req, res) => {
  try {
    const { document_id } = req.body;
    const { data, error } = await supabase
      .from('document_requests')
      .update({ status: 'fulfilled', fulfilled_doc: document_id })
      .eq('id', req.params.id)
      .select().single();
    if (error) throw error;
    res.json({ request: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
