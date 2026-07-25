'use strict';
const router      = require('express').Router();
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const passport    = require('../config/passport');
const { prisma }  = require('../utils/prisma');
const { logger }  = require('../utils/logger');
const { audit }   = require('../utils/audit');
const { encrypt, decrypt } = require('../utils/crypto');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const speakeasy   = require('otplib');
const QRCode      = require('qrcode');

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function sanitizeUser(user) {
  const { passwordHash, mfaTotpSecret, ...safe } = user;
  return safe;
}

// ── SIGN UP ───────────────────────────────────────────────────────
router.post('/signup', authLimiter,
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('name').trim().notEmpty().withMessage('Name required'),
    body('privacyAgreed').equals('true').withMessage('Privacy Policy agreement required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { email, password, name, org } = req.body;
    try {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });
      const passwordHash = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: { email, name, org: org || null, passwordHash, privacyAgreed: true, privacyAgreedAt: new Date(), privacyAgreedVersion: '1.0', signupIp: req.ip },
      });
      const token = signToken(user.id);
      await audit(user.id, 'SIGNUP', 'user', user.id, req);
      res.status(201).json({ token, user: sanitizeUser(user), paid: user.paid });
    } catch (err) {
      logger.error('Signup error:', err);
      res.status(500).json({ error: 'Signup failed. Please try again.' });
    }
  }
);

// ── SIGN IN ───────────────────────────────────────────────────────
router.post('/signin', authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { email, password } = req.body;
    try {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash) return res.status(401).json({ error: 'Invalid email or password.' });
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), lastLoginIp: req.ip } });
      await audit(user.id, 'LOGIN', 'user', user.id, req);
      if (user.mfaEnabled && user.mfaTotpSecret) {
        return res.json({ mfaRequired: true, userId: user.id });
      }
      const token = signToken(user.id);
      res.json({ token, user: sanitizeUser(user), paid: user.paid });
    } catch (err) {
      logger.error('Signin error:', err);
      res.status(500).json({ error: 'Sign in failed. Please try again.' });
    }
  }
);

// ── MFA VERIFY ────────────────────────────────────────────────────
router.post('/mfa/verify', authLimiter, async (req, res) => {
  const { userId, code } = req.body;
  if (!userId || !code) return res.status(400).json({ error: 'userId and code required' });
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.mfaTotpSecret) return res.status(400).json({ error: 'MFA not configured' });
    const secret = decrypt(user.mfaTotpSecret);
    const valid  = speakeasy.authenticator.verify({ token: code, secret, window: 1 });
    if (!valid) return res.status(401).json({ error: 'Invalid or expired code.' });
    await audit(userId, 'MFA_VERIFIED', 'user', userId, req);
    const token = signToken(user.id);
    res.json({ token, user: sanitizeUser(user), paid: user.paid });
  } catch (err) {
    res.status(500).json({ error: 'MFA verification failed.' });
  }
});

// ── MFA SETUP ─────────────────────────────────────────────────────
router.post('/mfa/setup', authenticate, async (req, res) => {
  try {
    const secret = speakeasy.authenticator.generateSecret({ length: 20 });
    const otpauthUrl = speakeasy.authenticator.keyuri(req.user.email, 'NexGenLegal', secret.base32);
    const qrCode = await QRCode.toDataURL(otpauthUrl);
    await prisma.user.update({ where: { id: req.user.id }, data: { mfaTotpSecret: encrypt(secret.base32) } });
    res.json({ qrCode, secret: secret.base32, otpauthUrl });
  } catch (err) {
    res.status(500).json({ error: 'MFA setup failed.' });
  }
});

router.post('/mfa/confirm', authenticate, async (req, res) => {
  const { code } = req.body;
  try {
    const user   = await prisma.user.findUnique({ where: { id: req.user.id } });
    const secret = decrypt(user.mfaTotpSecret);
    const valid  = speakeasy.authenticator.verify({ token: code, secret, window: 1 });
    if (!valid) return res.status(401).json({ error: 'Invalid code. Please try again.' });
    await prisma.user.update({ where: { id: req.user.id }, data: { mfaEnabled: true } });
    await audit(req.user.id, 'MFA_ENABLED', 'user', req.user.id, req);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'MFA confirmation failed.' });
  }
});

router.delete('/mfa', authenticate, async (req, res) => {
  await prisma.user.update({ where: { id: req.user.id }, data: { mfaEnabled: false, mfaTotpSecret: null } });
  await audit(req.user.id, 'MFA_DISABLED', 'user', req.user.id, req);
  res.json({ success: true });
});

// ── OAUTH2 — GOOGLE (only if configured) ─────────────────────────
router.get('/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
  }
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
});

router.get('/google/callback', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/?error=oauth_not_configured');
  passport.authenticate('google', { session: false, failureRedirect: '/?error=oauth_failed' },
    async (err, user) => {
      if (err || !user) return res.redirect('/?error=oauth_failed');
      const token = signToken(user.id);
      await audit(user.id, 'LOGIN_OAUTH_GOOGLE', 'user', user.id, req);
      const redirect = user.paid
        ? `${process.env.FRONTEND_URL}/#token=${token}&paid=true`
        : `${process.env.FRONTEND_URL}/#token=${token}&paid=false&paywall=true`;
      res.redirect(redirect);
    }
  )(req, res, next);
});

// ── OAUTH2 — MICROSOFT (only if configured) ───────────────────────
router.get('/microsoft', (req, res, next) => {
  if (!process.env.MICROSOFT_CLIENT_ID) {
    return res.status(503).json({ error: 'Microsoft sign-in is not configured on this server.' });
  }
  passport.authenticate('microsoft', { scope: ['user.read'], session: false })(req, res, next);
});

router.get('/microsoft/callback', (req, res, next) => {
  if (!process.env.MICROSOFT_CLIENT_ID) return res.redirect('/?error=oauth_not_configured');
  passport.authenticate('microsoft', { session: false, failureRedirect: '/?error=oauth_failed' },
    async (err, user) => {
      if (err || !user) return res.redirect('/?error=oauth_failed');
      const token = signToken(user.id);
      await audit(user.id, 'LOGIN_OAUTH_MICROSOFT', 'user', user.id, req);
      const redirect = user.paid
        ? `${process.env.FRONTEND_URL}/#token=${token}&paid=true`
        : `${process.env.FRONTEND_URL}/#token=${token}&paid=false&paywall=true`;
      res.redirect(redirect);
    }
  )(req, res, next);
});

// ── SIGN OUT ──────────────────────────────────────────────────────
router.post('/signout', authenticate, async (req, res) => {
  await audit(req.user.id, 'LOGOUT', 'user', req.user.id, req);
  res.json({ success: true });
});

// ── VERIFY TOKEN / GET ME ─────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(401).json({ error: 'User not found.' });
    res.json({ user: sanitizeUser(user), paid: user.paid });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

module.exports = router;
