# FoloPrint Design Studio

Standalone proof-of-concept product design studio for print-on-demand. NOT part of the FoloPrint
Laravel project. Never touch FoloPrint from here.

## Stack

- Monorepo: npm workspaces
- `apps/web`: Next.js 15 App Router, React 19, TypeScript strict, Fabric.js v6
- `apps/api`: NestJS 11, Prisma, PostgreSQL (Docker, host port 5433), sharp, @nestjs/throttler
- `packages/shared`: contract types + pure geometry validation (no runtime deps)
- `packages/renderer`: sharp mockup compositor
- Vault stack profiles: `Stacks/Next.js`, `Stacks/Nest+Prisma`

## Commands (run from repo root)

```bash
npm install                  # install all workspaces
npm run build:packages       # tsc build shared + renderer (required before api/web)
npm run db:up                # start Postgres (docker compose, host port 5433)
npm run db:migrate           # prisma migrate dev
npm run db:seed              # seed t-shirt template + generate placeholder images
npm run dev:api              # NestJS on :3001
npm run dev:web              # Next.js on :3000
npm run test:shared          # vitest geometry tests
npm run test:renderer        # vitest renderer tests
npm run test:api             # jest e2e (requires db up + seeded)
npm run test:web             # Playwright smoke (requires api + db seeded)
```

## Conventions

- All design coordinates are in template canvas space. Object `x`/`y` is the object CENTER
  (matches Fabric origin center). `rotation` in degrees.
- Server is the authority: every upload and design is re-validated server-side. Client clamping is
  UX only.
- API never returns filesystem paths. Files stream through `/assets/:id/file`,
  `/templates/:slug/image|overlay`, `/designs/:id/preview`.
- Storage paths in DB are relative to `STORAGE_ROOT`; `StorageService` is the only place that
  touches the filesystem layout.
- DTO validation with class-validator (`whitelist + forbidNonWhitelisted + transform`).
- Shared package is dependency-free pure TS; both web and api import it for the design contract.

## Hard boundaries

No auth, payments, Printful/Printify, WooCommerce, AI, 3D, deploys. No commits until user review.
