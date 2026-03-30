const supabase = require('../config/supabase');
const logger   = require('../utils/logger');

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

// Only allows admin users through
function requireAdmin(req, res, next) {
  if (req.profile?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Checks that a client user can only access their own client's data
async function requireClientAccess(req, res, next) {
  const { clientId } = req.params;

  // Admins bypass this check
  if (req.profile?.role === 'admin') return next();

  const { data, error } = await supabase
    .from('client_users')
    .select('id')
    .eq('user_id', req.user.id)
    .eq('client_id', clientId)
    .single();

  if (error || !data) {
    return res.status(403).json({ error: 'You do not have access to this client account' });
  }

  next();
}

module.exports = { requireAuth, requireAdmin, requireClientAccess };
