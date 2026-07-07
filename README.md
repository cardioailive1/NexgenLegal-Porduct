# NexGenLegal — Production Backend
### AI Legal & Government Documentation Platform
**Corverxis Technologies Ltd** · Accra, Ghana

---

## Overview

NexGenLegal is a full-stack SaaS platform for AI-powered legal and government documentation generation. Built on Node.js/Express with Prisma ORM, it serves 6 document modules — Court & Litigation, Contracts, Government, Legislative, International Law, and Accounting & Audit — across 180+ jurisdictions.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express.js |
| ORM | Prisma 5 |
| Database | PostgreSQL |
| AI Engine | Anthropic Claude (NexGen Ultra) |
| Payments | Stripe (Checkout + Webhooks) |
| Auth | JWT + OAuth2 (Google, Microsoft) |
| MFA | TOTP (RFC 6238) via otplib |
| Accounting OAuth | QuickBooks, Xero |
| Deployment | Render.com |

---

## Standards & Compliance

- **SOC 2 Type II ready** — audit log on every user action, IP logging, encrypted credentials
- **GDPR/CCPA** — data export endpoint, right-to-erasure flow, privacy consent timestamped
- **ISO 27001 aligned** — AES-256-GCM encryption for OAuth tokens and TOTP secrets
- **OWASP** — Helmet.js security headers, rate limiting, input validation, no stack trace exposure
- **HSTS** — enforced via Helmet with preload
- **OAuth2** — Google and Microsoft sign-in via Passport.js
- **Stripe PCI compliance** — card data never touches your server; all handled by Stripe

---

## Project Structure

```
nexgenlegal/
├── prisma/
│   ├── schema.prisma        # Full database schema (Users, Documents, Audit, etc.)
│   ├── seed.js              # Admin user seeder
│   └── migrations/          # Prisma migration files (auto-generated)
├── public/
│   └── index.html           # Frontend SPA (NexGenLegal UI)
├── src/
│   ├── server.js            # Express app entry point
│   ├── config/
│   │   ├── passport.js      # Google + Microsoft OAuth2
│   │   └── prompts.js       # AI system prompts for all 47 document types
│   ├── middleware/
│   │   ├── auth.js          # JWT authentication + requirePaid + requireAdmin
│   │   └── rateLimit.js     # Global, auth, and document-generation rate limits
│   ├── routes/
│   │   ├── auth.js          # Signup, signin, MFA, OAuth2 callbacks, signout
│   │   ├── documents.js     # AI document generation (streaming SSE), CRUD
│   │   ├── billing.js       # Stripe checkout, webhooks, portal, status
│   │   ├── accounting.js    # QuickBooks + Xero OAuth2 connections
│   │   ├── user.js          # Profile, password, GDPR export/deletion
│   │   └── admin.js         # Stats, user list, audit logs
│   └── utils/
│       ├── prisma.js        # Prisma client singleton
│       ├── logger.js        # Winston structured logging
│       ├── audit.js         # SOC2 audit trail helper
│       └── crypto.js        # AES-256-GCM encrypt/decrypt
├── .env.example             # All required environment variables
├── render.yaml              # Render.com deployment config (auto-deploys)
├── Procfile                 # Fallback process declaration
└── package.json
```

---

## Quick Start

### 1. Clone and install

```bash
git clone <your-repo>
cd nexgenlegal
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in all values in .env
```

### 3. Set up database

```bash
npx prisma generate
npx prisma db push          # development
# OR
npx prisma migrate deploy   # production
node prisma/seed.js         # creates admin user
```

### 4. Run

```bash
npm run dev    # development (nodemon)
npm start      # production
```

---

## Deploy to Render.com

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New Web Service** → connect your repo
3. Render auto-detects `render.yaml` and provisions:
   - A **Node.js web service** (runs `npm install && prisma generate && prisma migrate deploy && npm start`)
   - A **PostgreSQL database** (auto-connected via `DATABASE_URL`)
4. Add your environment variables in Render Dashboard → **Environment**:
   - `ANTHROPIC_API_KEY`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_PRICE_SOLO`, `STRIPE_PRICE_FIRM`, `STRIPE_PRICE_GOVERNMENT`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`
   - `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`
   - `APP_URL` (your Render URL e.g. `https://nexgenlegal.onrender.com`)
   - `FRONTEND_URL` (same as APP_URL)
   - `ALLOWED_ORIGINS` (same as APP_URL)
5. Deploy — Render runs migrations automatically on every deploy

### Stripe Webhook Setup

After deploying, go to **Stripe Dashboard → Developers → Webhooks → Add endpoint**:
- URL: `https://your-app.onrender.com/api/billing/webhook`
- Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
- Copy the **Signing secret** → set as `STRIPE_WEBHOOK_SECRET` in Render

### OAuth2 Setup

**Google:** console.cloud.google.com → OAuth2 credentials → add `https://your-app.onrender.com/api/auth/google/callback`

**Microsoft:** portal.azure.com → App registrations → add `https://your-app.onrender.com/api/auth/microsoft/callback`

---

## API Reference

### Auth
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/signup` | Create account |
| POST | `/api/auth/signin` | Sign in, returns JWT |
| POST | `/api/auth/mfa/verify` | Verify TOTP code |
| POST | `/api/auth/mfa/setup` | Get QR code for MFA setup |
| POST | `/api/auth/mfa/confirm` | Confirm and activate MFA |
| GET | `/api/auth/google` | Start Google OAuth2 flow |
| GET | `/api/auth/microsoft` | Start Microsoft OAuth2 flow |
| GET | `/api/auth/me` | Verify token, return user |
| POST | `/api/auth/signout` | Sign out |

### Documents
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/documents/generate` | Generate document (SSE streaming) |
| GET | `/api/documents` | List user's documents |
| GET | `/api/documents/:id` | Get single document |
| DELETE | `/api/documents/:id` | Delete document |

### Billing
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/billing/checkout` | Create Stripe Checkout session |
| POST | `/api/billing/webhook` | Stripe webhook receiver |
| GET | `/api/billing/status` | Get subscription status |
| POST | `/api/billing/portal` | Open Stripe billing portal |

### User
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/user/profile` | Get profile |
| PATCH | `/api/user/profile` | Update profile |
| POST | `/api/user/change-password` | Change password |
| GET | `/api/user/export` | Export data (GDPR) |
| DELETE | `/api/user/account` | Request account deletion (GDPR) |

### Accounting
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/accounting` | List connected systems |
| GET | `/api/accounting/quickbooks/connect` | Start QuickBooks OAuth2 |
| GET | `/api/accounting/xero/connect` | Start Xero OAuth2 |
| DELETE | `/api/accounting/:provider` | Disconnect accounting system |

---

## Security Notes

- Never commit `.env` to version control
- Rotate `JWT_SECRET` and `ENCRYPTION_KEY` if compromised
- `ENCRYPTION_KEY` must be exactly 32 bytes (64 hex characters)
- All OAuth tokens (QuickBooks, Xero) are encrypted with AES-256-GCM before storage
- Stripe card data never touches this server — Stripe handles PCI compliance
- The `requirePaid` middleware enforces subscriptions server-side; `localStorage` is never trusted for payment status

---

## License

Proprietary — Corverxis Technologies Ltd. All rights reserved.
