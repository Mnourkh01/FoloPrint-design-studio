-- CreateTable
CREATE TABLE "product_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "baseImagePath" TEXT NOT NULL,
    "overlayImagePath" TEXT,
    "canvasWidth" INTEGER NOT NULL,
    "canvasHeight" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_areas" (
    "id" UUID NOT NULL,
    "productTemplateId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "print_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uploaded_assets" (
    "id" UUID NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "storagePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploaded_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "design_projects" (
    "id" UUID NOT NULL,
    "productTemplateId" UUID NOT NULL,
    "designJson" JSONB NOT NULL,
    "previewPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "design_projects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_templates_slug_key" ON "product_templates"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "print_areas_productTemplateId_key_key" ON "print_areas"("productTemplateId", "key");

-- AddForeignKey
ALTER TABLE "print_areas" ADD CONSTRAINT "print_areas_productTemplateId_fkey" FOREIGN KEY ("productTemplateId") REFERENCES "product_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_projects" ADD CONSTRAINT "design_projects_productTemplateId_fkey" FOREIGN KEY ("productTemplateId") REFERENCES "product_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
