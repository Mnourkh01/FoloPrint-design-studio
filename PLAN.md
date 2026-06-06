# FoloPrint Design Studio - Plan

## Product

Standalone proof-of-concept design studio for print-on-demand products. A user opens a sample
t-shirt template, uploads a logo, positions it inside a defined print area (move, resize, rotate),
saves the design, and receives a realistic server-rendered 2D mockup.

This project is intentionally NOT connected to the existing FoloPrint Laravel platform. It is a
clean standalone system. Integration options are documented in `docs/ARCHITECTURE.md` and will be
decided later.

## Domain glossary

| Term | Meaning |
|---|---|
| Product template | A printable product (t-shirt) with a base image, optional overlay image, and a fixed canvas size |
| Print area | A rectangle on the template canvas where user artwork may be placed |
| Uploaded asset | A user-uploaded raster image (PNG or JPEG only in MVP) |
| Design project | A saved arrangement of assets inside one print area, stored as JSON |
| Mockup / preview | A server-rendered PNG composing base image, design layer, and overlay |
| Canvas space | Pixel coordinate system of the template (`canvasWidth` x `canvasHeight`). All design coordinates live here |

## Architecture

npm-workspaces monorepo:

- `apps/web` - Next.js 15 (App Router, strict TS) + Fabric.js v6 canvas editor
- `apps/api` - NestJS 11 + Prisma + PostgreSQL, controlled local-filesystem storage
- `packages/shared` - API contract types, design document schema, pure geometry validation (used by BOTH editor and API)
- `packages/renderer` - Sharp-based mockup compositor (pure, no Nest dependency)

Layered architecture, no Clean Architecture ceremony. CRUD + one compositional renderer does not
justify it.

Key invariant: **the server is the authority**. Client-side print-area clamping is UX. The API
re-validates file types (real bytes via sharp), dimensions, and design geometry before anything is
persisted or rendered.

## NFRs (MVP level)

- Upload: PNG/JPEG only, real-byte sniffing, max 10 MB, max 6000x6000 px, re-encoded on save (strips metadata, neutralizes payloads)
- No absolute paths in any API response; files streamed through ID-based endpoints
- Rate limits on upload and render endpoints
- No auth in MVP (explicitly out of scope)
- Storage abstracted behind a `StorageService` so S3/R2 can replace local disk later

## Quality

- Unit: geometry validation (shared), renderer output (renderer) - vitest
- Integration: API e2e via jest + supertest against live Postgres (health, templates, upload accept/reject, design accept/reject, render)
- E2E: Playwright smoke for the full editor flow
- Manual: browser walk-through before declaring done

## Phases

### v1 (shipped) - exit criteria
- [x] Seeded sample t-shirt template with one front print area
- [x] Editor: load template, upload logo, move/resize/rotate inside visible print area boundary
- [x] Save design -> server-side validation -> persisted design JSON
- [x] Generate mockup -> Sharp composition -> preview displayed in browser
- [x] All test suites pass; Playwright smoke green

### v1.2 (shipped) - multi print areas
- [x] Front + back print areas with own view images (template-level fallback)
- [x] Editor area switcher; one design covers both areas; per-area validation
- [x] Design document v2 (placements); v1 docs normalized at read, upgraded on save
- [x] One rendered preview per placed area (`/designs/:id/preview/:areaKey`)
- [x] Design re-open and edit restores every area
- See `docs/v1.2-multi-print-areas.md` for the technical plan

### Stable (next slice)
- Text objects with font rendering
- Per-template print-area DPI guidance and low-resolution warnings

### Production (later)
- Auth + ownership of designs
- S3/R2 storage driver
- Render queue (BullMQ) instead of inline render
- FoloPrint integration (see docs/ARCHITECTURE.md options)

## Out of scope (hard boundaries)

No checkout, orders, payments, Printful/Printify, WooCommerce, AI, 3D, auth, multi-product admin,
deploys. No FoloPrint code touched.
