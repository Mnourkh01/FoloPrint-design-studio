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
  Put,
  StreamableFile,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { DesignProjectDto, RenderResultDto } from '@foloprint/shared';
import { DesignsService } from './designs.service';
import { StorageService } from '../storage/storage.service';
import { CreateDesignDto } from './dto/create-design.dto';

/** Env-overridable so the e2e suite can exceed the human-scale default. */
const RENDER_THROTTLE_LIMIT = Number(process.env.RENDER_THROTTLE_LIMIT ?? 10);

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

  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDesignDto,
  ): Promise<DesignProjectDto> {
    return this.designs.update(id, dto);
  }

  @Post(':id/render')
  @HttpCode(201)
  @Throttle({ default: { limit: RENDER_THROTTLE_LIMIT, ttl: 60_000 } })
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
