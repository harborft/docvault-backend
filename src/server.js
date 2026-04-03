require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const logger     = require('./utils/logger');

const authRoutes          = require('./routes/auth');
const clientRoutes        = require('./routes/clients');
const documentRoutes      = require('./routes/documents');
const folderRoutes        = require('./routes/folders');
const requestRoutes       = require('./routes/requests');
const approvalRoutes      = require('./routes/approvals');
const auditRoutes         = require('./routes/audit');
const staffRoutes         = require('./routes/staff');
const pendingActionRoutes = require('./routes/pending-actions');

const app  = express();
const PORT = process.env.PORT || 4000;

// Enable 'trust proxy' so rate limiters inside cloud environments do not block the load balancer IP
app.set('trust proxy', 1);

// ── Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// ── CORS — only allow your frontend domain
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:3000',  // local dev only
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// ── Rate limiting — prevents brute force attacks
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,  // very strict on login attempts
  message: { error: 'Too many login attempts, please wait 15 minutes.' }
});

app.use('/api', generalLimiter);
// Apply strict rate limit only to auth write endpoints (not /me or /notifications)
app.use('/api/auth/register-client', authLimiter);
app.use('/api/auth/invite', authLimiter);


// ── Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request logging
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// ── Routes
app.use('/api/auth',            authRoutes);
app.use('/api/clients',         clientRoutes);
app.use('/api/documents',       documentRoutes);
app.use('/api/folders',         folderRoutes);
app.use('/api/requests',        requestRoutes);
app.use('/api/approvals',       approvalRoutes);
app.use('/api/audit',           auditRoutes);
app.use('/api/staff',           staffRoutes);
app.use('/api/pending-actions', pendingActionRoutes);

// ── Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (_req, res) => {
  res.json({ name: 'DocVault API', status: 'ok' });
});

// ── Global error handler
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'An internal error occurred'
      : err.message
  });
});

const server = app.listen(PORT, () => {
  logger.info(`DocVault API running on port ${PORT}`);
});

// ── Graceful shutdown
function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  // Force exit after 10s if connections hang
  setTimeout(() => process.exit(1), 10_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
