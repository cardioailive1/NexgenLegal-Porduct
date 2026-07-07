# Prisma Migrations

Run the following commands to set up your database:

```bash
# Generate Prisma client
npx prisma generate

# Push schema to database (development)
npx prisma db push

# Run migrations (production - recommended)
npx prisma migrate deploy

# Seed database with admin user
node prisma/seed.js

# Open Prisma Studio (GUI)
npx prisma studio
```
