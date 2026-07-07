'use strict';
const { PrismaClient } = require('@prisma/client');
const prisma = global.prisma || new PrismaClient({ log: ['error', 'warn'] });
if (process.env.NODE_ENV !== 'production') global.prisma = prisma;
module.exports = { prisma };
