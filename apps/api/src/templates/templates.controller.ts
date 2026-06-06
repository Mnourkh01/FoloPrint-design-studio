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

  @Get(':slug/areas/:key/image')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=300')
  async areaBaseImage(
    @Param('slug') slug: string,
    @Param('key') key: string,
  ): Promise<StreamableFile> {
    const template = await this.templates.findEntityBySlug(slug);
    const area = template.printAreas.find((a) => a.key === key);
    if (!area?.baseImagePath) {
      throw new NotFoundException(`Print area "${key}" has no area-specific image`);
    }
    return new StreamableFile(this.storage.readStream(area.baseImagePath));
  }

  @Get(':slug/areas/:key/overlay')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=300')
  async areaOverlayImage(
    @Param('slug') slug: string,
    @Param('key') key: string,
  ): Promise<StreamableFile> {
    const template = await this.templates.findEntityBySlug(slug);
    const area = template.printAreas.find((a) => a.key === key);
    if (!area?.overlayImagePath) {
      throw new NotFoundException(`Print area "${key}" has no area-specific overlay`);
    }
    return new StreamableFile(this.storage.readStream(area.overlayImagePath));
  }
}
