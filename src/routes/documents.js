'use strict';
const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { body, validationResult } = require('express-validator');
const { prisma } = require('../utils/prisma');
const { logger } = require('../utils/logger');
const { audit }  = require('../utils/audit');
const { authenticate, requirePaid } = require('../middleware/authMiddleware');
const { docLimiter } = require('../middleware/rateLimit');
const { LDP_PROMPTS } = require('../config/prompts');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── GENERATE DOCUMENT (streaming) ────────────────────────────────
router.post('/generate',
  authenticate,
  requirePaid,       // paywall enforced server-side
  docLimiter,
  [
    body('docType').notEmpty().withMessage('Document type required'),
    body('matter').notEmpty().withMessage('Matter/case name required'),
    body('jurisdiction').notEmpty().withMessage('Jurisdiction required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { docType, matter, jurisdiction, context, dataSource } = req.body;
    const systemPrompt = LDP_PROMPTS[docType];
    if (!systemPrompt) return res.status(400).json({ error: 'Unknown document type.' });

    const userPrompt = `Generate a complete, professionally drafted ${docType} for: ${matter}
Jurisdiction: ${jurisdiction}
${context ? `Additional context: ${context}` : ''}
${dataSource ? `Financial data source: ${dataSource}` : ''}

Write the ENTIRE document — all sections, all clauses, complete operative language.
Use Markdown headings (##, ###). Include all standard legal provisions.
The document should be ready for attorney review. Do not use placeholder text.`;

    try {
      // Set streaming headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering for Render

      let fullContent = '';

      const stream = await anthropic.messages.stream({
        model:      process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        max_tokens: 16000,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
          fullContent += chunk.delta.text;
          res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();

      // Persist document + increment usage counter in background
      setImmediate(async () => {
        try {
          await prisma.$transaction([
            prisma.document.create({
              data: {
                userId:      req.user.id,
                title:       `${docType} — ${matter}`,
                docType,
                module:      getModule(docType),
                jurisdiction,
                matter,
                content:     fullContent,
                wordCount:   fullContent.split(/\s+/).length,
                dataSource:  dataSource || 'manual',
              },
            }),
            prisma.user.update({
              where: { id: req.user.id },
              data:  { docsUsed: { increment: 1 } },
            }),
          ]);
          await audit(req.user.id, 'DOC_GENERATED', 'document', docType, req);
        } catch (e) {
          logger.error('Failed to persist document:', e);
        }
      });

    } catch (err) {
      logger.error('Document generation error:', err);
      // Never expose API internals to client
      const isQuota = err.status === 429 || err.status === 402 || (err.message || '').toLowerCase().includes('credit');
      if (!res.headersSent) {
        res.status(isQuota ? 503 : 500).json({
          error: 'Our document generation service is temporarily busy. Please try again in a few minutes, or contact support@corverxis.com',
        });
      } else {
        res.write(`data: ${JSON.stringify({ error: 'Generation interrupted. Please try again.' })}\n\n`);
        res.end();
      }
    }
  }
);

// ── LIST USER DOCUMENTS ───────────────────────────────────────────
router.get('/', authenticate, requirePaid, async (req, res) => {
  const { page = 1, limit = 20, module, docType } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const where = { userId: req.user.id, ...(module && { module }), ...(docType && { docType }) };
  try {
    const [docs, total] = await prisma.$transaction([
      prisma.document.findMany({ where, skip, take: Number(limit), orderBy: { createdAt: 'desc' }, select: { id: true, title: true, docType: true, module: true, jurisdiction: true, createdAt: true, wordCount: true, status: true } }),
      prisma.document.count({ where }),
    ]);
    res.json({ documents: docs, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch documents.' });
  }
});

// ── GET SINGLE DOCUMENT ───────────────────────────────────────────
router.get('/:id', authenticate, requirePaid, async (req, res) => {
  try {
    const doc = await prisma.document.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    res.json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch document.' });
  }
});

// ── DELETE DOCUMENT ───────────────────────────────────────────────
router.delete('/:id', authenticate, requirePaid, async (req, res) => {
  try {
    const doc = await prisma.document.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    await prisma.document.delete({ where: { id: req.params.id } });
    await audit(req.user.id, 'DOC_DELETED', 'document', req.params.id, req);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete document.' });
  }
});

// ── HELPER ────────────────────────────────────────────────────────
function getModule(docType) {
  const map = {
    complaint: 'court', 'motion-dismiss': 'court', 'motion-summary': 'court',
    'appellate-brief': 'court', 'court-order': 'court', discovery: 'court',
    affidavit: 'court', settlement: 'court',
    commercial: 'contracts', nda: 'contracts', employment: 'contracts',
    saas: 'contracts', mou: 'contracts', lease: 'contracts',
    'ip-license': 'contracts', jv: 'contracts', ma: 'contracts', shareholders: 'contracts',
    'exec-order': 'government', 'policy-memo': 'government', 'white-paper': 'government',
    regulation: 'government', decree: 'government', gazette: 'government',
    bill: 'legislative', act: 'legislative', resolution: 'legislative',
    amendment: 'legislative', 'committee-report': 'legislative', 'reg-impact': 'legislative',
    treaty: 'international', 'un-resolution': 'international', 'icj-memorial': 'international',
    'wto-submission': 'international', 'diplomatic-note': 'international', extradition: 'international',
    'financial-full': 'financial', 'profit-loss': 'financial', 'balance-sheet': 'financial',
    'cash-flow': 'financial', 'audit-independent': 'financial', 'audit-internal': 'financial',
    'mgmt-letter': 'financial', 'compliance-audit': 'financial',
  };
  return map[docType] || 'other';
}

module.exports = router;
