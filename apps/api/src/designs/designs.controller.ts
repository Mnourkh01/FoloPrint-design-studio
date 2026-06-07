import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { DesignListDto, DesignProjectDto, RenderResultDto } from '@foloprint/shared';
import { DesignsService } from './designs.service';
import { StorageService } from '../storage/storage.service';
import { CreateDesignDto } from './dto/create-design.dto';
import { ListDesignsQueryDto } from './dto/list-designs.query.dto';

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

  /** Paginated design library; summaries only, never full design documents. */
  @Get()
  list(@Query() query: ListDesignsQueryDto): Promise<DesignListDto> {
    return this.designs.list(query.page, query.pageSize);
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

  /** Renders every placement; one preview per print area. */
  @Post(':id/render')
  @HttpCode(201)
  @Throttle({ default: { limit: RENDER_THROTTLE_LIMIT, ttl: 60_000 } })
  render(@Param('id', ParseUUIDPipe) id: string): Promise<RenderResultDto> {
    return this.designs.render(id);
  }

  @Get(':id/preview/:printAreaKey')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'no-cache')
  async preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('printAreaKey') printAreaKey: string,
  ): Promise<StreamableFile> {
    const previewPath = await this.designs.findPreview(id, printAreaKey);
    return new StreamableFile(this.storage.readStream(previewPath));
  }

  /**
   * Production print file for one placed area: the ink alone, transparent
   * background, print resolution (300dpi over the area's physical size).
   * Generated on demand from the stored design; nothing is persisted.
   * Throttled like render: it is the same sharp/Pango work per request.
   */
  @Get(':id/print-file/:printAreaKey')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'no-cache')
  @Throttle({ default: { limit: RENDER_THROTTLE_LIMIT, ttl: 60_000 } })
  async printFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('printAreaKey') printAreaKey: string,
  ): Promise<StreamableFile> {
    const png = await this.designs.renderPrintFile(id, printAreaKey);
    return new StreamableFile(png, {
      disposition: `attachment; filename="design-${id.slice(0, 8)}-${printAreaKey}-print.png"`,
    });
  }
}
