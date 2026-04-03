// routes/pending-actions.js
const express  = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const logger   = require('../utils/logger');
const { logAction } = require('../utils/audit');
const { scopeToAssigned, hasClientAccess } = require('../utils/scope');
const { validate, validateQuery, validateParams, idParam, createPendingActionBody, reviewPendingActionBody, pendingActionsListQuery } = require('../utils/validation');
const router   = express.Router();

// List pending actions — owner sees all, manager sees assigned clients
router.get('/', requireAuth, requireRole('owner', 'manager', 'staff_accountant'), validateQuery(pendingActionsListQuery), async (req, res) => {
  try {
    const { status, client_id, limit, offset } = req.query;
    let query = supabase
      .from('pending_actions')
      .select('*, clients(name), profiles!requested_by(full_name)')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (status)    query = query.eq('status', status);
    if (client_id) query = query.eq('client_id', client_id);
    query = await scopeToAssigned(query, req.user.id, req.profile.role);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ actions: data });
  } catch (err) { logger.error('List pending actions error', { error: err.message }); res.status(500).json({ error: 'Failed to list pending actions' }); }
});

// Staff accountant creates a pending action
router.post('/', requireAuth, requireRole('staff_accountant'), validate(createPendingActionBody), async (req, res) => {
  try {
    const { action_type, client_id, document_id, payload } = req.body;

    // Verify staff is assigned to this client
    const access = await hasClientAccess(req.user.id, req.profile.role, client_id);
    if (!access) return res.status(403).json({ error: 'You are not assigned to this client' });

    // If flagging a document, verify document exists and belongs to the client
    if (action_type === 'flag_document' && document_id) {
      const { data: doc } = await supabase
        .from('documents').select('client_id').eq('id', document_id).single();
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      if (doc.client_id !== client_id) return res.status(400).json({ error: 'Document does not belong to this client' });
    }

    const { data, error } = await supabase
      .from('pending_actions')
      .insert({
        action_type,
        client_id,
        document_id: document_id || null,
        payload,
        requested_by: req.user.id,
      })
      .select()
      .single();
    if (error) throw error;

    // Notify owners and assigned managers
    const { data: owners } = await supabase
      .from('profiles').select('id').eq('role', 'owner');
    const { data: managers } = await supabase
      .from('staff_client_assignments').select('user_id')
      .eq('client_id', client_id);
    const managerIds = (managers || [])
      .map(m => m.user_id)
      .filter(id => id !== req.user.id);
    const ownerIds = (owners || []).map(o => o.id);
    const notifyIds = [...new Set([...ownerIds, ...managerIds])];

    if (notifyIds.length) {
      await supabase.from('notifications').insert(
        notifyIds.map(uid => ({
          user_id:      uid,
          title:        'Pending Action Requested',
          body:         `Staff requests: ${action_type.replace(/_/g, ' ')}`,
          type:         'pending_action',
          reference_id: data.id,
        }))
      );
    }

    await logAction({
      action: 'pending_action_created',
      userId: req.user.id,
      clientId: client_id,
      metadata: { action_type, pending_action_id: data.id },
    });

    res.status(201).json({ action: data });
  } catch (err) { logger.error('Create pending action error', { error: err.message }); res.status(500).json({ error: 'Failed to create pending action' }); }
});

// Owner or manager reviews (approves/rejects) a pending action
router.patch('/:id', requireAuth, requireRole('owner', 'manager'), validateParams(idParam), validate(reviewPendingActionBody), async (req, res) => {
  try {
    const { status, review_note } = req.body;

    // Fetch the pending action
    const { data: action, error: fetchErr } = await supabase
      .from('pending_actions').select('*').eq('id', req.params.id).single();
    if (fetchErr || !action) return res.status(404).json({ error: 'Pending action not found' });
    if (action.status !== 'pending') return res.status(400).json({ error: 'Action has already been reviewed' });

    // Manager must be assigned to the client
    if (req.profile.role === 'manager') {
      const access = await hasClientAccess(req.user.id, req.profile.role, action.client_id);
      if (!access) return res.status(403).json({ error: 'You are not assigned to this client' });
    }

    // Update the pending action
    const { data: updated, error: updateErr } = await supabase
      .from('pending_actions')
      .update({ status, review_note, reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    // If approved, execute the action
    if (status === 'approved') {
      await executeAction(action);
    }

    // Notify the requester
    await supabase.from('notifications').insert({
      user_id:      action.requested_by,
      title:        `Action ${status.charAt(0).toUpperCase() + status.slice(1)}`,
      body:         `Your ${action.action_type.replace(/_/g, ' ')} request was ${status}${review_note ? `: ${review_note}` : ''}`,
      type:         'pending_action_review',
      reference_id: action.id,
    });

    await logAction({
      action: `pending_action_${status}`,
      userId: req.user.id,
      clientId: action.client_id,
      metadata: { pending_action_id: action.id, action_type: action.action_type },
    });

    res.json({ action: updated });
  } catch (err) { logger.error('Review pending action error', { error: err.message }); res.status(500).json({ error: 'Failed to review pending action' }); }
});

// ── Execute approved actions ──────────────────────────────────────
async function executeAction(action) {
  try {
    switch (action.action_type) {
      case 'flag_document': {
        if (!action.document_id) break;
        await supabase
          .from('documents')
          .update({ status: 'flagged' })
          .eq('id', action.document_id);
        break;
      }
      case 'request_upload': {
        const p = action.payload || {};
        await supabase.from('document_requests').insert({
          client_id:    action.client_id,
          title:        p.title || 'Document requested',
          description:  p.description || null,
          due_date:     p.due_date || null,
          requested_by: action.requested_by,
        });
        break;
      }
      case 'create_folder': {
        const p = action.payload || {};
        await supabase.from('folders').insert({
          client_id: action.client_id,
          name:      p.folder_name || 'New Folder',
        });
        break;
      }
    }
  } catch (err) {
    logger.error('Execute pending action failed', { actionId: action.id, error: err.message });
  }
}

module.exports = router;
