-- AlterTable
ALTER TABLE "print_areas" ADD COLUMN     "maskImagePath" TEXT,
ADD COLUMN     "overlayBlend" TEXT;

-- AlterTable
ALTER TABLE "product_templates" ADD COLUMN     "maskImagePath" TEXT,
ADD COLUMN     "overlayBlend" TEXT NOT NULL DEFAULT 'over';
