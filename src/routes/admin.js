'use strict';
const router  = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authenticate, requireAdmin } = require('../middleware/auth');

// All admin routes require admin role
router.use(authenticate, requireAdmin);

router.get('/stats', async (_req, res) => {
  const [users, docs, subs] = await prisma.$transaction([
    prisma.user.count(),
    prisma.document.count(),
    prisma.user.count({ where: { paid: true } }),
  ]);
  res.json({ totalUsers: users, totalDocuments: docs, activeSubscriptions: subs });
});

router.get('/users', async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const users = await prisma.user.findMany({
    skip, take: Number(limit), orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, name: true, org: true, paid: true, plan: true, docsUsed: true, createdAt: true, subscriptionStatus: true },
  });
  res.json({ users });
});

router.get('/audit-logs', async (req, res) => {
  const { page = 1, limit = 100, userId, action } = req.query;
  const skip  = (Number(page) - 1) * Number(limit);
  const where = { ...(userId && { userId }), ...(action && { action }) };
  const logs  = await prisma.auditLog.findMany({ where, skip, take: Number(limit), orderBy: { createdAt: 'desc' } });
  res.json({ logs });
});

module.exports = router;
