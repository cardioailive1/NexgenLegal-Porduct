'use strict';
const passport  = require('passport');
const GoogleStrategy    = require('passport-google-oauth20').Strategy;
const MicrosoftStrategy = require('passport-microsoft').Strategy;
const { prisma } = require('../utils/prisma');
const { logger } = require('../utils/logger');

async function findOrCreateOAuthUser(profile, provider) {
  const email = profile.emails?.[0]?.value;
  if (!email) throw new Error('No email from OAuth provider');

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name: profile.displayName || email.split('@')[0],
        emailVerified: true,
        emailVerifiedAt: new Date(),
        privacyAgreed: true,
        privacyAgreedAt: new Date(),
        privacyAgreedVersion: '1.0',
      },
    });
  }

  await prisma.oauthAccount.upsert({
    where:  { provider_providerAccountId: { provider, providerAccountId: profile.id } },
    create: { userId: user.id, provider, providerAccountId: profile.id },
    update: { updatedAt: new Date() },
  });

  return user;
}

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL,
}, async (_at, _rt, profile, done) => {
  try {
    const user = await findOrCreateOAuthUser(profile, 'google');
    done(null, user);
  } catch (e) {
    logger.error('Google OAuth error:', e);
    done(e, null);
  }
}));

passport.use(new MicrosoftStrategy({
  clientID:     process.env.MICROSOFT_CLIENT_ID,
  clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  callbackURL:  process.env.MICROSOFT_CALLBACK_URL,
  scope:        ['user.read'],
}, async (_at, _rt, profile, done) => {
  try {
    const user = await findOrCreateOAuthUser(profile, 'microsoft');
    done(null, user);
  } catch (e) {
    logger.error('Microsoft OAuth error:', e);
    done(e, null);
  }
}));

module.exports = passport;
