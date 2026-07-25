'use strict';
const jwt    = require('jsonwebtoken');
const { prisma } = require('../utils/prisma');

const ADMIN_EMAILS = ['tonywell@cardioailive.com'];

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required.' });
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return res.status(401).json({ error: 'User not found.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function requirePaid(req, res, next) {
  // Admin emails bypass the paywall entirely
  if (ADMIN_EMAILS.includes((req.user?.email || '').toLowerCase())) return next();
  if (!req.user?.paid) return res.status(403).json({ error: 'An active subscription is required.', paywall: true });
  next();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_EMAILS.includes((req.user?.email || '').toLowerCase()) && req.user?.email !== process.env.ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  next();
}

module.exports = { authenticate, requirePaid, requireAdmin };
