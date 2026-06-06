import { Injectable, NotFoundException } from '@nestjs/common';
import type { PrintArea, ProductTemplate } from '@prisma/client';
import type { ProductTemplateDto } from '@foloprint/shared';
import { PrismaService } from '../prisma/prisma.service';

type TemplateWithAreas = ProductTemplate & { printAreas: PrintArea[] };

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllActive(): Promise<ProductTemplateDto[]> {
    const templates = await this.prisma.productTemplate.findMany({
      where: { active: true },
      include: { printAreas: { where: { active: true }, orderBy: { key: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    return templates.map((t) => this.toDto(t));
  }

  async findBySlug(slug: string): Promise<ProductTemplateDto> {
    const template = await this.findEntityBySlug(slug);
    return this.toDto(template);
  }

  /** Internal use only (file streaming, render pipeline). Never serialize this to a response. */
  async findEntityBySlug(slug: string): Promise<TemplateWithAreas> {
    const template = await this.prisma.productTemplate.findFirst({
      where: { slug, active: true },
      include: { printAreas: { where: { active: true }, orderBy: { key: 'asc' } } },
    });
    if (!template) {
      throw new NotFoundException(`Template "${slug}" not found`);
    }
    return template;
  }

  /** Maps the entity to its public shape. Storage paths intentionally never leave the server. */
  private toDto(template: TemplateWithAreas): ProductTemplateDto {
    return {
      id: template.id,
      name: template.name,
      slug: template.slug,
      canvasWidth: template.canvasWidth,
      canvasHeight: template.canvasHeight,
      imageUrl: `/templates/${template.slug}/image`,
      overlayUrl: template.overlayImagePath ? `/templates/${template.slug}/overlay` : null,
      printAreas: template.printAreas.map((area) => ({
        id: area.id,
        key: area.key,
        name: area.name,
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
      })),
    };
  }
}
