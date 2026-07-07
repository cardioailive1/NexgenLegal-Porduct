'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { prisma } = require('../utils/prisma');
const { audit }  = require('../utils/audit');
const { authenticate } = require('../middleware/auth');

// ── GET PROFILE ───────────────────────────────────────────────────
router.get('/profile', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, email: true, name: true, org: true, paid: true, plan: true, mfaEnabled: true, docsUsed: true, docsLimit: true, createdAt: true, subscriptionStatus: true },
  });
  res.json({ user });
});

// ── UPDATE PROFILE ────────────────────────────────────────────────
router.patch('/profile', authenticate, async (req, res) => {
  const { name, org } = req.body;
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { ...(name && { name }), ...(org !== undefined && { org }) },
    select: { id: true, email: true, name: true, org: true },
  });
  await audit(req.user.id, 'PROFILE_UPDATED', 'user', req.user.id, req);
  res.json({ user });
});

// ── CHANGE PASSWORD ───────────────────────────────────────────────
router.post('/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (user.passwordHash) {
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const hash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: hash } });
  await audit(req.user.id, 'PASSWORD_CHANGED', 'user', req.user.id, req);
  res.json({ success: true });
});

// ── GDPR: DATA EXPORT (right to portability) ─────────────────────
router.get('/export', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, email: true, name: true, org: true, createdAt: true, paid: true, plan: true } });
  const documents = await prisma.document.findMany({ where: { userId: req.user.id }, select: { id: true, title: true, docType: true, jurisdiction: true, matter: true, createdAt: true } });
  await audit(req.user.id, 'DATA_EXPORTED', 'user', req.user.id, req);
  res.json({ exportedAt: new Date().toISOString(), user, documents });
});

// ── GDPR: REQUEST DELETION (right to erasure) ─────────────────────
router.delete('/account', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  await prisma.deletionRequest.create({ data: { userId: user.id, email: user.email } });
  await prisma.user.update({ where: { id: user.id }, data: { deletionRequestedAt: new Date() } });
  await audit(req.user.id, 'DELETION_REQUESTED', 'user', req.user.id, req);
  res.json({ success: true, message: 'Your deletion request has been received. Your account and data will be deleted within 30 days per our Privacy Policy.' });
});

module.exports = router;
