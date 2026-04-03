// routes/documents.js — updated for OneDrive + Supabase dual-write
//
// What this does on every upload:
//   1. Validates the file and user permissions (unchanged)
//   2. Uploads the file to SharePoint/OneDrive via Microsoft Graph
//   3. Saves metadata + OneDrive reference to Supabase (no file bytes stored there)
//   4. Notifies admins and logs the audit entry (unchanged)
//
// Downloads return a short-lived OneDrive URL (expires ~1hr).
// The file itself lives only in OneDrive — Supabase holds zero bytes.

const express  = require('express');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const graph    = require('../config/graph');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/audit');
const logger   = require('../utils/logger');
const { scopeToAssigned, hasClientAccess } = require('../utils/scope');
const { validateQuery, validateParams, idParam, documentListQuery, updateStatusBody, validate } = require('../utils/validation');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 100 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg', 'image/png', 'image/webp', 'image/heic',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/csv',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`File type not allowed: ${file.mimetype}`));
  },
});

// ── GET /api/documents
// All roles can list documents — scoped to their assigned clients
router.get('/', requireAuth, validateQuery(documentListQuery), async (req, res) => {
  try {
    const { client_id, folder_id, status, limit, offset } = req.query;

    let query = supabase
      .from('documents')
      .select('*, clients(name), folders(name), profiles!uploaded_by(full_name)')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Scope to assigned clients
    query = await scopeToAssigned(query, req.user.id, req.profile.role);

    if (client_id) query = query.eq('client_id', client_id);

    if (folder_id) query = query.eq('folder_id', folder_id);
    if (status)    query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ documents: data });
  } catch (err) {
    logger.error('List documents error', { error: err.message });
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

// ── POST /api/documents/upload
// All roles except readonly_reviewer can upload
router.post('/upload', requireAuth, requireRole('owner', 'manager', 'staff_accountant', 'client'), upload.array('files'), async (req, res) => {
  try {
    const { client_id, folder_id, tags, upload_source = 'web' } = req.body;

    if (!client_id)                      return res.status(400).json({ error: 'client_id is required' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files provided' });

    // Verify access to this client
    const allowed = await hasClientAccess(req.user.id, req.profile.role, client_id);
    if (!allowed) return res.status(403).json({ error: 'Access denied to this client' });

    const { data: client, error: clientErr } = await supabase
      .from('clients').select('name').eq('id', client_id).single();
    if (clientErr || !client) return res.status(404).json({ error: 'Client not found' });

    let folderName = 'Other';
    if (folder_id) {
      const { data: folder } = await supabase
        .from('folders').select('name').eq('id', folder_id).single();
      if (folder) folderName = folder.name;
    }

    const safeName   = client.name.replace(/[/\\:*?"<>|]/g, '-');
    const folderPath = `Clients/${safeName}/${folderName}`;

    const oneDriveFolderId = await graph.ensureFolder(folderPath);

    const uploaded = [];

    for (const file of req.files) {
      try {
        const fileId = uuidv4();
        const ext    = file.originalname.split('.').pop().toLowerCase();
        const odName = `${fileId}.${ext}`;

        logger.info(`Uploading to OneDrive: ${odName} → ${folderPath}`);
        const odFile = await graph.uploadFile(
          file.buffer, odName, oneDriveFolderId, file.mimetype
        );

        if (!odFile?.id) {
          logger.error('OneDrive upload returned no item ID', { file: file.originalname });
          continue;
        }

        const { data: doc, error: dbErr } = await supabase
          .from('documents')
          .insert({
            id:               fileId,
            client_id,
            folder_id:        folder_id || null,
            uploaded_by:      req.user.id,
            file_name:        odName,
            original_name:    file.originalname,
            file_type:        ext,
            mime_type:        file.mimetype,
            file_size:        file.size,
            storage_path:     odFile.id,
            onedrive_web_url: odFile.webUrl || null,
            onedrive_path:    `${folderPath}/${odName}`,
            upload_source,
            status:           'pending',
            tags:             tags ? (() => { try { return JSON.parse(tags); } catch { return []; } })() : [],
          })
          .select().single();

        if (dbErr) {
          logger.error('Supabase insert error', { error: dbErr.message });
          continue;
        }

        uploaded.push(doc);

        await logAction({
          userId: req.user.id, clientId: client_id, documentId: fileId,
          action: 'upload',
          metadata: { filename: file.originalname, size: file.size,
                      source: upload_source, onedrive_path: folderPath },
          req,
        });
      } catch (fileErr) {
        logger.error(`Failed: ${file.originalname}`, { error: fileErr.message });
      }
    }

    await notifyReviewers(client_id, client.name, uploaded.length);

    res.status(201).json({
      message:   `${uploaded.length} of ${req.files.length} file(s) uploaded to OneDrive`,
      documents: uploaded,
    });
  } catch (err) {
    logger.error('Upload route error', { error: err.message });
    res.status(500).json({ error: 'Failed to upload documents' });
  }
});

// ── GET /api/documents/:id/download
// All roles can download — access checked per-document
router.get('/:id/download', requireAuth, validateParams(idParam), async (req, res) => {
  try {
    const { data: doc, error } = await supabase
      .from('documents').select('*').eq('id', req.params.id).single();
    if (error || !doc) return res.status(404).json({ error: 'Document not found' });

    // Verify access to the document's client
    const allowed = await hasClientAccess(req.user.id, req.profile.role, doc.client_id);
    if (!allowed) return res.status(403).json({ error: 'Access denied' });

    const downloadUrl = await graph.getDownloadUrl(doc.storage_path);

    await logAction({
      userId: req.user.id, clientId: doc.client_id,
      documentId: doc.id, action: 'download', req,
    });

    res.json({ url: downloadUrl, expires_in: 3600 });
  } catch (err) {
    logger.error('Download error', { error: err.message });
    res.status(500).json({ error: 'Failed to generate download link' });
  }
});

// ── PATCH /api/documents/:id/status
// Owner and manager can directly change status
router.patch('/:id/status', requireAuth, requireRole('owner', 'manager'), validateParams(idParam), validate(updateStatusBody), async (req, res) => {
  try {
    const { status, review_note } = req.body;

    const { data: doc, error } = await supabase
      .from('documents')
      .update({ status, review_note: review_note || null,
                reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*, clients(name)').single();

    if (error) throw error;

    await notifyClientOfReview(doc, status, req.profile.full_name);
    await logAction({
      userId: req.user.id, clientId: doc.client_id,
      documentId: doc.id, action: status, metadata: { review_note }, req,
    });

    res.json({ document: doc });
  } catch (err) {
    logger.error('Status update error', { error: err.message });
    res.status(500).json({ error: 'Failed to update document status' });
  }
});

// ── DELETE /api/documents/:id
// Owner only
router.delete('/:id', requireAuth, requireRole('owner'), validateParams(idParam), async (req, res) => {
  try {
    await supabase.from('documents').update({ status: 'archived' }).eq('id', req.params.id);
    res.json({ message: 'Document archived in DocVault. File remains in OneDrive.' });
  } catch (err) {
    logger.error('Archive document error', { error: err.message });
    res.status(500).json({ error: 'Failed to archive document' });
  }
});

// ── Helpers
// Notify all owners and managers assigned to this client
async function notifyReviewers(clientId, clientName, count) {
  try {
    // Get owners (see everything)
    const { data: owners } = await supabase.from('profiles').select('id').eq('role', 'owner');
    // Get managers assigned to this client
    const { data: managers } = await supabase
      .from('staff_client_assignments')
      .select('user_id, profiles!user_id(role)')
      .eq('client_id', clientId);
    const managerIds = (managers || [])
      .filter(m => m.profiles?.role === 'manager')
      .map(m => m.user_id);

    const recipientIds = [...new Set([...(owners || []).map(o => o.id), ...managerIds])];
    if (!recipientIds.length) return;

    await supabase.from('notifications').insert(
      recipientIds.map(id => ({
        user_id: id, title: 'New Document Upload',
        body: `${clientName} uploaded ${count} file(s) — ready for review. Check OneDrive.`,
        type: 'upload', reference_id: clientId,
      }))
    );
  } catch (err) { logger.warn('Admin notify failed', { error: err.message }); }
}

async function notifyClientOfReview(doc, status, reviewerName) {
  try {
    const { data: users } = await supabase
      .from('client_users').select('user_id').eq('client_id', doc.client_id);
    if (!users?.length) return;
    const label = status === 'approved' ? 'approved ✓' : 'flagged — please check your portal';
    await supabase.from('notifications').insert(
      users.map(u => ({
        user_id: u.user_id,
        title:   `Document ${status === 'approved' ? 'Approved' : 'Flagged'}`,
        body:    `"${doc.original_name}" was ${label} by ${reviewerName}.`,
        type: 'approval', reference_id: doc.id,
      }))
    );
  } catch (err) { logger.warn('Client notify failed', { error: err.message }); }
}

module.exports = router;
