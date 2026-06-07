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

  @Get(':slug/thumb')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=300')
  async thumbImage(@Param('slug') slug: string): Promise<StreamableFile> {
    const template = await this.templates.findEntityBySlug(slug);
    if (!template.thumbImagePath) {
      throw new NotFoundException(`Template "${slug}" has no thumb image`);
    }
    return new StreamableFile(this.storage.readStream(template.thumbImagePath));
  }

  @Get(':slug/colors/:colorKey/image')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=300')
  async colorImage(
    @Param('slug') slug: string,
    @Param('colorKey') colorKey: string,
  ): Promise<StreamableFile> {
    const color = await this.findColor(slug, colorKey);
    return new StreamableFile(this.storage.readStream(color.baseImagePath));
  }

  @Get(':slug/colors/:colorKey/thumb')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=300')
  async colorThumb(
    @Param('slug') slug: string,
    @Param('colorKey') colorKey: string,
  ): Promise<StreamableFile> {
    const color = await this.findColor(slug, colorKey);
    return new StreamableFile(this.storage.readStream(color.thumbImagePath));
  }

  @Get(':slug/colors/:colorKey/areas/:key/image')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=300')
  async colorAreaImage(
    @Param('slug') slug: string,
    @Param('colorKey') colorKey: string,
    @Param('key') key: string,
  ): Promise<StreamableFile> {
    const image = await this.findColorAreaImage(slug, colorKey, key);
    return new StreamableFile(this.storage.readStream(image.baseImagePath));
  }

  @Get(':slug/colors/:colorKey/areas/:key/thumb')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=300')
  async colorAreaThumb(
    @Param('slug') slug: string,
    @Param('colorKey') colorKey: string,
    @Param('key') key: string,
  ): Promise<StreamableFile> {
    const image = await this.findColorAreaImage(slug, colorKey, key);
    return new StreamableFile(this.storage.readStream(image.thumbImagePath));
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

  @Get(':slug/areas/:key/thumb')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=300')
  async areaThumbImage(
    @Param('slug') slug: string,
    @Param('key') key: string,
  ): Promise<StreamableFile> {
    const template = await this.templates.findEntityBySlug(slug);
    const area = template.printAreas.find((a) => a.key === key);
    if (!area?.thumbImagePath) {
      throw new NotFoundException(`Print area "${key}" has no area-specific thumb`);
    }
    return new StreamableFile(this.storage.readStream(area.thumbImagePath));
  }

  /** Resolves one active color of an active template, for the color file streams. */
  private async findColor(slug: string, colorKey: string) {
    const template = await this.templates.findEntityBySlug(slug);
    const color = template.colors.find((c) => c.key === colorKey);
    if (!color) {
      throw new NotFoundException(`Template "${slug}" has no color "${colorKey}"`);
    }
    return color;
  }

  /** Resolves a color's area-specific view image (e.g. the colored back blank). */
  private async findColorAreaImage(slug: string, colorKey: string, areaKey: string) {
    const template = await this.templates.findEntityBySlug(slug);
    const color = template.colors.find((c) => c.key === colorKey);
    if (!color) {
      throw new NotFoundException(`Template "${slug}" has no color "${colorKey}"`);
    }
    const area = template.printAreas.find((a) => a.key === areaKey);
    const image = area && color.areaImages.find((img) => img.printAreaId === area.id);
    if (!image) {
      throw new NotFoundException(
        `Color "${colorKey}" has no area-specific image for print area "${areaKey}"`,
      );
    }
    return image;
  }
}
