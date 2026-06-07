-- CreateTable
CREATE TABLE "template_colors" (
    "id" UUID NOT NULL,
    "productTemplateId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hex" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "baseImagePath" TEXT NOT NULL,
    "thumbImagePath" TEXT NOT NULL,

    CONSTRAINT "template_colors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_color_area_images" (
    "id" UUID NOT NULL,
    "templateColorId" UUID NOT NULL,
    "printAreaId" UUID NOT NULL,
    "baseImagePath" TEXT NOT NULL,
    "thumbImagePath" TEXT NOT NULL,

    CONSTRAINT "template_color_area_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "template_colors_productTemplateId_key_key" ON "template_colors"("productTemplateId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "template_color_area_images_templateColorId_printAreaId_key" ON "template_color_area_images"("templateColorId", "printAreaId");

-- AddForeignKey
ALTER TABLE "template_colors" ADD CONSTRAINT "template_colors_productTemplateId_fkey" FOREIGN KEY ("productTemplateId") REFERENCES "product_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_color_area_images" ADD CONSTRAINT "template_color_area_images_templateColorId_fkey" FOREIGN KEY ("templateColorId") REFERENCES "template_colors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_color_area_images" ADD CONSTRAINT "template_color_area_images_printAreaId_fkey" FOREIGN KEY ("printAreaId") REFERENCES "print_areas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
