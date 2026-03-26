require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const logger     = require('./utils/logger');

const authRoutes      = require('./routes/auth');
const clientRoutes    = require('./routes/clients');
const documentRoutes  = require('./routes/documents');
const folderRoutes    = require('./routes/folders');
const requestRoutes   = require('./routes/requests');
const approvalRoutes  = require('./routes/approvals');
const auditRoutes     = require('./routes/audit');

const app  = express();
const PORT = process.env.PORT || 4000;

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
app.use('/api/auth', authLimiter);

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
app.use('/api/auth',      authRoutes);
app.use('/api/clients',   clientRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/folders',   folderRoutes);
app.use('/api/requests',  requestRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/audit',     auditRoutes);

// ── Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

app.listen(PORT, () => {
  logger.info(`DocVault API running on port ${PORT}`);
});

module.exports = app;
