'use strict';
require('dotenv').config();
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const morgan      = require('morgan');
const path        = require('path');
const { logger }  = require('./utils/logger');
const { limiter } = require('./middleware/rateLimit');

const app  = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// ── SECURITY HEADERS ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc:     ["'self'", 'fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:', 'blob:'],
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// ── CORS ──────────────────────────────────────────────────────────
// In production allow the app's own origin; in development allow all
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (no origin header) — covers server-side rendering
    if (!origin) return cb(null, true);
    // Allow in development
    if (!isProd) return cb(null, true);
    // Allow configured origins in production
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
}));

// ── BODY PARSING ──────────────────────────────────────────────────
// Raw body for Stripe webhook — must come before express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

// ── LOGGING ───────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: msg => logger.info(msg.trim()) },
  skip: req => req.path === '/health',
}));

// ── RATE LIMITING ─────────────────────────────────────────────────
app.use('/api/', limiter);

// ── REQUEST ID ────────────────────────────────────────────────────
app.use((req, _res, next) => {
  req.id = req.headers['x-request-id'] || require('uuid').v4();
  next();
});

// ── PASSPORT (OAuth2) ─────────────────────────────────────────────
const passport = require('./config/passport');
app.use(passport.initialize());

// ── API ROUTES ────────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/documents',  require('./routes/documents'));
app.use('/api/billing',    require('./routes/billing'));
app.use('/api/accounting', require('./routes/accounting'));
app.use('/api/user',       require('./routes/user'));
app.use('/api/admin',      require('./routes/admin'));

// ── HEALTH CHECK ──────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  service: 'NexGenLegal',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}));

// ── SERVE FRONTEND (SPA) ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── GLOBAL ERROR HANDLER ──────────────────────────────────────────
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  logger.error(`[${req.id || 'no-id'}] ${err.message}`);
  res.status(status).json({
    error: status < 500
      ? err.message
      : 'An internal error occurred. Please contact support@corverxis.com',
  });
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`NexGenLegal running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = app;
