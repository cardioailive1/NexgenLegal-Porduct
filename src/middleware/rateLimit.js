'use strict';
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      Number(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
});

const docLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Too many document generation requests. Please slow down.' },
});

module.exports = { limiter, authLimiter, docLimiter };
