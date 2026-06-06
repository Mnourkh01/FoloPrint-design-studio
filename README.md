# FoloPrint Design Studio

Standalone proof-of-concept design studio for print-on-demand products. Upload a logo onto a sample
t-shirt, position it inside the print area, save the design, and get a server-rendered 2D mockup.

Not connected to the FoloPrint Laravel platform. See `docs/ARCHITECTURE.md` for the system design
and future integration options.

## Stack

| Piece | Tech |
|---|---|
| Frontend | Next.js 15, React 19, TypeScript, Fabric.js v6 |
| Backend | NestJS 11, Prisma, PostgreSQL 16 |
| Rendering | sharp (libvips) |
| Shared contract | `packages/shared` (types + geometry validation, used by both sides) |
| Local dev | Docker Compose (Postgres only; apps run on the host) |

## Prerequisites

- Node.js >= 20
- Docker Desktop (for Postgres)

## Setup

```bash
npm install                # install all workspaces
npm run build:packages     # build shared + renderer (api and web import the compiled output)
npm run db:up              # start Postgres on host port 5433
npm run db:migrate         # create schema (prisma migrate dev)
npm run db:seed            # seed sample t-shirt template + generate placeholder images
```

The API reads `apps/api/.env` (created from `.env.example` automatically by setup, or copy it
yourself):

```
DATABASE_URL=postgresql://foloprint:foloprint@localhost:5433/foloprint_design_studio
PORT=3001
WEB_ORIGIN=http://localhost:3000
STORAGE_ROOT=./storage
```

## Run

```bash
npm run dev:api            # NestJS on http://localhost:3001
npm run dev:web            # Next.js on http://localhost:3000  (second terminal)
```

Open http://localhost:3000, open the sample tee, upload a PNG/JPEG logo, position it, Save Design,
Generate Mockup. From a design's preview page, "Edit design" re-opens it in the editor
(`/editor/:slug?design=:id`); saving there updates the same design and clears the stale previews.
The Design Library (`/designs`, linked from the topbar) lists all saved designs with thumbnails,
newest first, with View and Edit actions.

## Tests

```bash
npm run test:shared        # vitest - geometry validation unit tests
npm run test:renderer      # vitest - renderer produces a real PNG
npm run test:api           # jest e2e - requires db up + migrated + seeded, api NOT running (test boots its own)
npm run test:web           # Playwright smoke - requires db up + seeded; starts api + web itself
npm run test               # shared + renderer + api
```

First Playwright run may need `npx playwright install chromium`.

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/templates` | active templates + print areas |
| GET | `/templates/:slug` | one template |
| GET | `/templates/:slug/image` / `/overlay` | template images (streamed) |
| POST | `/assets/upload` | multipart upload, PNG/JPEG only, validated by real bytes |
| GET | `/assets/:id/file` | uploaded asset (streamed) |
| POST | `/designs` | save design JSON (server-side geometry validation) |
| GET | `/designs` | paginated design library (summaries: template, object counts, preview metadata) |
| GET | `/designs/:id` | design + preview URLs |
| PUT | `/designs/:id` | replace design JSON (same validation; clears all stale previews) |
| POST | `/designs/:id/render` | compose one mockup PNG per placed area with sharp |
| GET | `/designs/:id/preview/:printAreaKey` | rendered area mockup (streamed) |

## Project structure

```
apps/web              Next.js editor (/, /editor/[templateSlug], /designs, /designs/[id])
apps/api              NestJS API + Prisma schema + seed + e2e tests
packages/shared       design contract types + print-area geometry validation
packages/renderer     sharp mockup compositor
docs/ARCHITECTURE.md  system design + FoloPrint integration options
docker-compose.yml    Postgres 16 (host port 5433)
```

## MVP limitations

- One seeded template (front + back print areas), raster uploads only (no SVG by design)
- No auth; designs are anonymous
- Inline rendering (no queue); local filesystem storage (S3/R2 swap designed, not built)
- Editor not optimized for mobile
