import { Controller, Get, Header, NotFoundException, Param, StreamableFile } from '@nestjs/common';
import type { ProductTemplateDto } from '@foloprint/shared';
import { StorageService } from '../storage/storage.service';
import { TemplatesService } from './templates.service';

@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  list(): Promise<ProductTemplateDto[]> {
    return this.templates.findAllActive();
  }

  @Get(':slug')
  get(@Param('slug') slug: string): Promise<ProductTemplateDto> {
    return this.templates.findBySlug(slug);
  }

  @Get(':slug/image')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=300')
  async baseImage(@Param('slug') slug: string): Promise<StreamableFile> {
    const template = await this.templates.findEntityBySlug(slug);
    return new StreamableFile(this.storage.readStream(template.baseImagePath));
  }

  @Get(':slug/overlay')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=300')
  async overlayImage(@Param('slug') slug: string): Promise<StreamableFile> {
    const template = await this.templates.findEntityBySlug(slug);
    if (!template.overlayImagePath) {
      throw new NotFoundException(`Template "${slug}" has no overlay image`);
    }
    return new StreamableFile(this.storage.readStream(template.overlayImagePath));
  }
}
