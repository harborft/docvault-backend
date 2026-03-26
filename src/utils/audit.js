// utils/audit.js
const supabase = require('../config/supabase');

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
  } catch (_err) {
    // Audit logging should never crash the request
  }
}

module.exports = { logAction };
