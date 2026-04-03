// utils/audit.js
const supabase = require('../config/supabase');
const logger   = require('./logger');

async function logAction({ userId, clientId, documentId, action, metadata = {}, req }) {
  try {
    await supabase.from('audit_log').insert({
      user_id:     userId     || null,
      client_id:   clientId   || null,
      document_id: documentId || null,
      action,
      metadata,
      ip_address:  req?.ip     || null,
      user_agent:  req?.get('user-agent') || null
    });
  } catch (err) {
    logger.warn('Audit logging failed', { action, error: err.message });
  }
}

module.exports = { logAction };
