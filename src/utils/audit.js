'use strict';
const { prisma } = require('./prisma');
const { logger } = require('./logger');

async function audit(userId, action, resource, resourceId, req, metadata) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: userId || null,
        action, resource, resourceId: resourceId || null,
        ipAddress: req?.ip || null,
        userAgent: req?.headers?.['user-agent'] || null,
        metadata: metadata || null,
        severity: ['SIGNUP','LOGIN','LOGOUT','DOC_GENERATED'].includes(action) ? 'info' : 'info',
      },
    });
  } catch (e) {
    logger.warn('Audit log failed:', e.message);
  }
}

module.exports = { audit };
