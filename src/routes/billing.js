'use strict';
const router  = require('express').Router();
const Stripe  = require('stripe');
const { prisma } = require('../utils/prisma');
const { logger } = require('../utils/logger');
const { audit }  = require('../utils/audit');
const { authenticate } = require('../middleware/auth');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLAN_MAP = {
  [process.env.STRIPE_PRICE_SOLO]:       { name: 'Solo Practitioner', limit: 50 },
  [process.env.STRIPE_PRICE_FIRM]:       { name: 'Law Firm',          limit: 0  }, // 0 = unlimited
  [process.env.STRIPE_PRICE_GOVERNMENT]: { name: 'Government',        limit: 0  },
};

// ── CREATE CHECKOUT SESSION ───────────────────────────────────────
router.post('/checkout', authenticate, async (req, res) => {
  const { priceId } = req.body;
  if (!PLAN_MAP[priceId]) return res.status(400).json({ error: 'Invalid plan.' });

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name:  user.name || undefined,
        metadata: { userId: user.id, platform: 'NexGenLegal' },
      });
      customerId = customer.id;
      await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customerId } });
    }

    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}/?payment=cancelled`,
      client_reference_id: user.id,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      customer_update: { address: 'auto' },
      tax_id_collection: { enabled: true }, // GDPR/international tax compliance
      metadata: { userId: user.id, plan: PLAN_MAP[priceId].name },
    });

    await audit(user.id, 'CHECKOUT_STARTED', 'subscription', priceId, req);
    res.json({ url: session.url });
  } catch (err) {
    logger.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

// ── STRIPE WEBHOOK (raw body required) ────────────────────────────
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency — skip already-processed events
  const existing = await prisma.stripeEvent.findUnique({ where: { id: event.id } });
  if (existing?.processed) return res.json({ received: true });

  // Log event for SOC2 audit trail
  await prisma.stripeEvent.upsert({
    where:  { id: event.id },
    create: { id: event.id, type: event.type, payload: event },
    update: {},
  });

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session   = event.data.object;
        const userId    = session.client_reference_id;
        const subId     = session.subscription;
        const sub       = await stripe.subscriptions.retrieve(subId);
        const priceId   = sub.items.data[0]?.price?.id;
        const plan      = PLAN_MAP[priceId];

        if (userId && plan) {
          await prisma.user.update({
            where: { id: userId },
            data: {
              paid: true,
              plan: plan.name,
              stripeSubscriptionId: subId,
              subscriptionStatus:   'active',
              docsLimit: plan.limit,
              subscriptionEndsAt: null,
            },
          });
          await audit(userId, 'SUBSCRIPTION_ACTIVATED', 'subscription', plan.name, null, { stripeEventId: event.id });
          logger.info(`Subscription activated: userId=${userId} plan=${plan.name}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub     = event.data.object;
        const user    = await prisma.user.findFirst({ where: { stripeSubscriptionId: sub.id } });
        if (user) {
          const priceId = sub.items.data[0]?.price?.id;
          const plan    = PLAN_MAP[priceId];
          await prisma.user.update({
            where: { id: user.id },
            data: {
              subscriptionStatus: sub.status,
              paid: sub.status === 'active',
              ...(plan && { plan: plan.name, docsLimit: plan.limit }),
            },
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub  = event.data.object;
        const user = await prisma.user.findFirst({ where: { stripeSubscriptionId: sub.id } });
        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: {
              paid: false, plan: '',
              subscriptionStatus:   'canceled',
              stripeSubscriptionId: null,
              docsLimit: 0,
            },
          });
          await audit(user.id, 'SUBSCRIPTION_CANCELED', 'subscription', sub.id, null, { stripeEventId: event.id });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const user    = await prisma.user.findFirst({ where: { stripeCustomerId: invoice.customer } });
        if (user) {
          await prisma.user.update({ where: { id: user.id }, data: { subscriptionStatus: 'past_due' } });
          await audit(user.id, 'PAYMENT_FAILED', 'subscription', invoice.id, null, { stripeEventId: event.id });
        }
        break;
      }
    }

    await prisma.stripeEvent.update({ where: { id: event.id }, data: { processed: true, processedAt: new Date() } });
    res.json({ received: true });

  } catch (err) {
    logger.error('Webhook processing error:', err);
    await prisma.stripeEvent.update({ where: { id: event.id }, data: { error: err.message } });
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

// ── GET SUBSCRIPTION STATUS ───────────────────────────────────────
router.get('/status', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { paid: true, plan: true, subscriptionStatus: true, docsUsed: true, docsLimit: true, subscriptionEndsAt: true },
  });
  res.json(user);
});

// ── CUSTOMER PORTAL (manage/cancel subscription) ──────────────────
router.post('/portal', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.stripeCustomerId) return res.status(400).json({ error: 'No subscription found.' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: process.env.FRONTEND_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to open billing portal.' });
  }
});

module.exports = router;
