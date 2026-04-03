// utils/scope.js
// Applies client-scoping to Supabase queries based on the user's role.
// Owner sees everything. Staff/manager/reviewer see assigned clients only. Client sees own client.

const supabase = require('../config/supabase');

/**
 * Scope a Supabase query to only the clients the user has access to.
 * @param {object} query    - Supabase query builder (must have a client_id column)
 * @param {string} userId   - The user's UUID
 * @param {string} role     - The user's role
 * @param {string} [clientIdColumn='client_id'] - Column name for client FK
 * @returns {object} The scoped query
 */
async function scopeToAssigned(query, userId, role, clientIdColumn = 'client_id') {
  if (role === 'owner') return query; // sees everything

  if (role === 'client') {
    const { data } = await supabase
      .from('client_users')
      .select('client_id')
      .eq('user_id', userId);
    return query.in(clientIdColumn, data?.map(r => r.client_id) || []);
  }

  // manager, staff_accountant, readonly_reviewer
  const { data } = await supabase
    .from('staff_client_assignments')
    .select('client_id')
    .eq('user_id', userId);
  return query.in(clientIdColumn, data?.map(r => r.client_id) || []);
}

/**
 * Get the list of client IDs a user has access to.
 * @param {string} userId
 * @param {string} role
 * @returns {string[]} Array of client UUIDs
 */
async function getAssignedClientIds(userId, role) {
  if (role === 'owner') return null; // null = no filter needed

  if (role === 'client') {
    const { data } = await supabase
      .from('client_users')
      .select('client_id')
      .eq('user_id', userId);
    return data?.map(r => r.client_id) || [];
  }

  const { data } = await supabase
    .from('staff_client_assignments')
    .select('client_id')
    .eq('user_id', userId);
  return data?.map(r => r.client_id) || [];
}

/**
 * Check if a user has access to a specific client.
 * @param {string} userId
 * @param {string} role
 * @param {string} clientId
 * @returns {boolean}
 */
async function hasClientAccess(userId, role, clientId) {
  if (role === 'owner') return true;

  if (role === 'client') {
    const { data } = await supabase
      .from('client_users')
      .select('id')
      .eq('user_id', userId)
      .eq('client_id', clientId)
      .single();
    return !!data;
  }

  const { data } = await supabase
    .from('staff_client_assignments')
    .select('id')
    .eq('user_id', userId)
    .eq('client_id', clientId)
    .single();
  return !!data;
}

module.exports = { scopeToAssigned, getAssignedClientIds, hasClientAccess };
