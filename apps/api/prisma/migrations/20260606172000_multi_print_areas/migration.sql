-- v1.2 multi print areas
-- 1. design_projects: previewPath (single file) becomes previewPaths (JSON map of
--    printAreaKey -> { path, renderedAt }). Existing previews are stale POC artifacts;
--    they re-render on demand, so no backfill.
-- 2. print_areas: optional area-specific view images; null falls back to the
--    template-level baseImagePath/overlayImagePath.

-- AlterTable
ALTER TABLE "design_projects" DROP COLUMN "previewPath",
ADD COLUMN     "previewPaths" JSONB;

-- AlterTable
ALTER TABLE "print_areas" ADD COLUMN     "baseImagePath" TEXT,
ADD COLUMN     "overlayImagePath" TEXT;
