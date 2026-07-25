'use strict';
const router  = require('express').Router();
const axios   = require('axios');
const { prisma } = require('../utils/prisma');
const { logger } = require('../utils/logger');
const { audit }  = require('../utils/audit');
const { authenticate, requirePaid } = require('../middleware/authMiddleware');
const { encrypt, decrypt } = require('../utils/crypto');

// ── QUICKBOOKS OAUTH2 ─────────────────────────────────────────────
const QB_AUTH_URL     = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL    = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_REVOKE_URL   = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const QB_SCOPE        = 'com.intuit.quickbooks.accounting';

router.get('/quickbooks/connect', authenticate, requirePaid, (req, res) => {
  const state = Buffer.from(JSON.stringify({ userId: req.user.id, ts: Date.now() })).toString('base64');
  const params = new URLSearchParams({
    client_id:     process.env.QUICKBOOKS_CLIENT_ID,
    redirect_uri:  process.env.QUICKBOOKS_CALLBACK_URL,
    response_type: 'code',
    scope:         QB_SCOPE,
    state,
  });
  res.redirect(`${QB_AUTH_URL}?${params}`);
});

router.get('/quickbooks/callback', authenticate, async (req, res) => {
  const { code, state, realmId } = req.query;
  if (!code) return res.redirect(`${process.env.FRONTEND_URL}?error=qb_oauth_failed`);

  let userId;
  try {
    userId = JSON.parse(Buffer.from(state, 'base64').toString()).userId;
  } catch {
    return res.redirect(`${process.env.FRONTEND_URL}?error=invalid_state`);
  }

  try {
    const credentials = Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64');
    const { data } = await axios.post(QB_TOKEN_URL,
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.QUICKBOOKS_CALLBACK_URL }),
      { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    await prisma.accountingConnection.upsert({
      where:  { userId_provider: { userId, provider: 'quickbooks' } },
      create: {
        userId, provider: 'quickbooks',
        providerAccountId: realmId,
        accessToken:  encrypt(data.access_token),
        refreshToken: encrypt(data.refresh_token),
        tokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
        scope: QB_SCOPE, status: 'active',
      },
      update: {
        accessToken:  encrypt(data.access_token),
        refreshToken: encrypt(data.refresh_token),
        tokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
        status: 'active', lastSyncAt: new Date(),
      },
    });

    await audit(userId, 'ACCOUNTING_CONNECTED', 'accounting_connection', 'quickbooks', null);
    res.redirect(`${process.env.FRONTEND_URL}?accounting=quickbooks_connected`);
  } catch (err) {
    logger.error('QuickBooks OAuth callback error:', err);
    res.redirect(`${process.env.FRONTEND_URL}?error=qb_token_failed`);
  }
});

// ── XERO OAUTH2 ───────────────────────────────────────────────────
const XERO_AUTH_URL   = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL  = 'https://identity.xero.com/connect/token';
const XERO_SCOPE      = 'openid profile email accounting.reports.read accounting.settings.read offline_access';

router.get('/xero/connect', authenticate, requirePaid, (req, res) => {
  const state = Buffer.from(JSON.stringify({ userId: req.user.id, ts: Date.now() })).toString('base64');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.XERO_CLIENT_ID,
    redirect_uri:  process.env.XERO_CALLBACK_URL,
    scope:         XERO_SCOPE,
    state,
  });
  res.redirect(`${XERO_AUTH_URL}?${params}`);
});

router.get('/xero/callback', authenticate, async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.redirect(`${process.env.FRONTEND_URL}?error=xero_oauth_failed`);

  let userId;
  try {
    userId = JSON.parse(Buffer.from(state, 'base64').toString()).userId;
  } catch {
    return res.redirect(`${process.env.FRONTEND_URL}?error=invalid_state`);
  }

  try {
    const credentials = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64');
    const { data } = await axios.post(XERO_TOKEN_URL,
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.XERO_CALLBACK_URL }),
      { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    await prisma.accountingConnection.upsert({
      where:  { userId_provider: { userId, provider: 'xero' } },
      create: {
        userId, provider: 'xero',
        accessToken:  encrypt(data.access_token),
        refreshToken: data.refresh_token ? encrypt(data.refresh_token) : null,
        tokenExpiresAt: new Date(Date.now() + (data.expires_in || 1800) * 1000),
        scope: XERO_SCOPE, status: 'active',
      },
      update: {
        accessToken:  encrypt(data.access_token),
        refreshToken: data.refresh_token ? encrypt(data.refresh_token) : null,
        tokenExpiresAt: new Date(Date.now() + (data.expires_in || 1800) * 1000),
        status: 'active', lastSyncAt: new Date(),
      },
    });

    await audit(userId, 'ACCOUNTING_CONNECTED', 'accounting_connection', 'xero', null);
    res.redirect(`${process.env.FRONTEND_URL}?accounting=xero_connected`);
  } catch (err) {
    logger.error('Xero OAuth callback error:', err);
    res.redirect(`${process.env.FRONTEND_URL}?error=xero_token_failed`);
  }
});

// ── LIST CONNECTIONS ──────────────────────────────────────────────
router.get('/', authenticate, requirePaid, async (req, res) => {
  const connections = await prisma.accountingConnection.findMany({
    where:  { userId: req.user.id },
    select: { provider: true, companyName: true, status: true, lastSyncAt: true, tokenExpiresAt: true },
  });
  res.json({ connections });
});

// ── DISCONNECT ────────────────────────────────────────────────────
router.delete('/:provider', authenticate, requirePaid, async (req, res) => {
  const { provider } = req.params;
  await prisma.accountingConnection.updateMany({
    where:  { userId: req.user.id, provider },
    data:   { status: 'revoked', accessToken: null, refreshToken: null },
  });
  await audit(req.user.id, 'ACCOUNTING_DISCONNECTED', 'accounting_connection', provider, req);
  res.json({ success: true });
});

module.exports = router;
