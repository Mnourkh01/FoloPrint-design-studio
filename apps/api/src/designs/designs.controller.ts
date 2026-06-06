import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { DesignProjectDto, RenderResultDto } from '@foloprint/shared';
import { DesignsService } from './designs.service';
import { StorageService } from '../storage/storage.service';
import { CreateDesignDto } from './dto/create-design.dto';

@Controller('designs')
export class DesignsController {
  constructor(
    private readonly designs: DesignsService,
    private readonly storage: StorageService,
  ) {}

  @Post()
  create(@Body() dto: CreateDesignDto): Promise<DesignProjectDto> {
    return this.designs.create(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<DesignProjectDto> {
    return this.designs.findById(id);
  }

  @Post(':id/render')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  render(@Param('id', ParseUUIDPipe) id: string): Promise<RenderResultDto> {
    return this.designs.render(id);
  }

  @Get(':id/preview')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'no-cache')
  async preview(@Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const design = await this.designs.findEntity(id);
    if (!design.previewPath) {
      throw new NotFoundException('This design has not been rendered yet');
    }
    return new StreamableFile(this.storage.readStream(design.previewPath));
  }
}
