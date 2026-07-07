'use strict';
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding NexGenLegal database...');

  // Create admin user
  const bcrypt = require('bcryptjs');
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@corverxis.com';
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (!existing) {
    await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'NexGenLegal Admin',
        org: 'Corverxis Technologies Ltd',
        passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD || 'ChangeMe123!', 12),
        emailVerified: true,
        emailVerifiedAt: new Date(),
        paid: true,
        plan: 'Enterprise',
        privacyAgreed: true,
        privacyAgreedAt: new Date(),
        privacyAgreedVersion: '1.0',
        docsLimit: 0,
      },
    });
    console.log(`✓ Admin user created: ${adminEmail}`);
  } else {
    console.log(`✓ Admin user already exists: ${adminEmail}`);
  }

  console.log('✓ Seeding complete');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
