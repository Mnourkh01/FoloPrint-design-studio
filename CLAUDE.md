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
- Design document is v2: `{ version: 2, templateId, placements: [{ printAreaKey, objects }] }`.
  Legacy v1 docs normalize at read time (`normalizeDesignDocument`) and upgrade on save.
- Server is the authority: every upload and design is re-validated server-side, per placement
  against its own print area. Client clamping is UX only.
- API never returns filesystem paths. Files stream through `/assets/:id/file`,
  `/templates/:slug/image|overlay|thumb`, `/templates/:slug/areas/:key/image|overlay|thumb`,
  `/designs/:id/preview/:printAreaKey`, `/fonts/:key/file`.
- Photo templates (v1.7B): template/area carry an optional garment `mask` (design ink is
  clipped to its alpha at render time) and an `overlayBlend` ('over'|'multiply'|'soft-light');
  the editor mirrors the blend with a canvas composite op so live view matches the server
  render. Source blanks + the derivation script live in `apps/api/prisma/assets/`; the seed
  copies them into storage.
- Pattern tiling (v1.9): optional `pattern` ({type grid|mirror|half-drop, spacing 0..100})
  on image objects; the object's box is the BASE TILE and the fill covers the whole print
  area (clipped to it), phase anchored to the tile position. Patterned objects must have
  rotation 0. Editor preview = meta-tile canvas in a Fabric Pattern fill on an area-sized
  rect; server tiles on a margin-padded sheet (sharp rejects negative composite offsets)
  then extracts the area rect.
- Background removal (`POST /assets/:id/remove-background`) derives a NEW png asset by
  border flood-fill (flat backgrounds only, renderer `removeFlatBackground`); the source
  asset is immutable. Crop (`POST /assets/:id/crop`, body = source-space int rect) follows
  the same derived-asset pattern; the editor's crop frame carries the image's angle so
  rotated images crop correctly.
- Design objects are a discriminated union on `type: "image" | "text"`; a stored object
  without `type` is a legacy image and normalizes at read time. Text fonts come from the
  shared whitelist (`packages/shared/src/fonts.ts`); binaries live in
  `packages/renderer/fonts/<key>/` (OFL/Apache only, license file checked in) and only the
  renderer touches them (`resolveFont`).
- Text direction/wrap (v1.6): optional `direction` ('ltr'|'rtl'|'auto', default auto via
  shared `resolveTextDirection` first-strong scan) and `wrapMode` ('none'|'box').
  `wrappedLines` is a derived cache, required iff wrapMode is 'box'; the editor is the
  only wrap engine, the server renders the lines verbatim after verifying they reconcile
  with raw `text` (whitespace-stripped). Direction is forced at render time with
  zero-width LRM/RLM marks per line, never stored; stored text rejects all bidi control
  characters. Pango flips left/right align for RTL, so the renderer swaps them to keep
  `align` visual.
- Text effects (v1.8): optional `outline` ({color, width 1..20}) and `shadow`
  ({color, offsetX/offsetY within +-25, never both zero}). Editor = Fabric stroke
  (paintFirst 'stroke'; the measured box includes it) + Shadow (blur 0; never in the
  box). Server: outline ring-composited at width/2 BEFORE the fit-to-box, shadow
  composited AFTER the fit at exact canvas px; shadow pixels may extend past the
  stored box (bounded by the offset clamp) while geometry validation stays on the
  glyph box. Optional `letterSpacing` (canvas px, -20..100): Fabric em-based
  charSpacing in the editor, Pango letter_spacing span on the server. libvips
  parses the text param as Pango MARKUP, so the renderer markup-escapes every
  user line (`escapePangoMarkup`); only validated numeric attribute values are
  ever emitted as markup.
- Storage paths in DB are relative to `STORAGE_ROOT`; `StorageService` is the only place that
  touches the filesystem layout.
- DTO validation with class-validator (`whitelist + forbidNonWhitelisted + transform`).
- Shared package is dependency-free pure TS; both web and api import it for the design contract.

## Hard boundaries

No auth, payments, Printful/Printify, WooCommerce, AI, 3D, deploys. No commits until user review.
