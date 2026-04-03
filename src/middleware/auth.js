const supabase = require('../config/supabase');
const logger   = require('../utils/logger');

// ── All valid roles, ordered by privilege level (highest first)
const ROLES = ['owner', 'manager', 'staff_accountant', 'readonly_reviewer', 'client'];

// ── Internal (non-client) roles
const INTERNAL_ROLES = ['owner', 'manager', 'staff_accountant', 'readonly_reviewer'];

// Verifies the user's JWT from Supabase Auth
// Attaches req.user and req.profile to every protected request
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.split(' ')[1];

    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }

    // Fetch their profile (role, name, etc.)
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'User profile not found' });
    }

    req.user    = user;
    req.profile = profile;
  } catch (err) {
    logger.error('Auth middleware error', { error: err.message });
    return res.status(500).json({ error: 'Authentication error' });
  }

  next();
}

// ── Role-based access: only allows listed roles through
// Usage: requireRole('owner', 'manager')
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.profile?.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ── Client-scoped access for any role
// Owner: always passes (sees everything)
// Internal staff (manager/staff/reviewer): checks staff_client_assignments
// Client: checks client_users
async function requireClientAccess(req, res, next) {
  const clientId = req.params.clientId || req.params.id;
  const role     = req.profile?.role;

  // Owner bypasses — sees everything
  if (role === 'owner') return next();

  try {
    if (role === 'client') {
      // Client: check client_users table
      const { data } = await supabase
        .from('client_users')
        .select('id')
        .eq('user_id', req.user.id)
        .eq('client_id', clientId)
        .single();
      if (!data) return res.status(403).json({ error: 'You do not have access to this client account' });
    } else if (INTERNAL_ROLES.includes(role)) {
      // Staff/manager/reviewer: check staff_client_assignments
      const { data } = await supabase
        .from('staff_client_assignments')
        .select('id')
        .eq('user_id', req.user.id)
        .eq('client_id', clientId)
        .single();
      if (!data) return res.status(403).json({ error: 'You are not assigned to this client' });
    } else {
      return res.status(403).json({ error: 'Invalid role' });
    }
  } catch (err) {
    logger.error('Client access check error', { error: err.message });
    return res.status(500).json({ error: 'Authorization error' });
  }

  next();
}

module.exports = { requireAuth, requireRole, requireClientAccess, ROLES, INTERNAL_ROLES };