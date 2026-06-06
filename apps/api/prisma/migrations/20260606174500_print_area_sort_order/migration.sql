-- Editor tab/display order for print areas (front = 0, back = 1, ...).
-- key-asc ordering would put "back" before "front"; explicit order fixes the UX.

-- AlterTable
ALTER TABLE "print_areas" ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;
