import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { IsInt, Min } from 'class-validator';
import type { Response } from 'express';
import type { UploadedAssetDto } from '@foloprint/shared';
import { memoryStorage } from 'multer';
import { AssetsService } from './assets.service';
import { StorageService } from '../storage/storage.service';

/** Crop rect in SOURCE image pixel space; bounds-checked against the file in the service. */
export class CropAssetDto {
  @IsInt()
  @Min(0)
  left!: number;

  @IsInt()
  @Min(0)
  top!: number;

  @IsInt()
  @Min(1)
  width!: number;

  @IsInt()
  @Min(1)
  height!: number;
}

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024);
/** Env-overridable so the e2e suite can exceed the human-scale default. */
const UPLOAD_THROTTLE_LIMIT = Number(process.env.UPLOAD_THROTTLE_LIMIT ?? 12);

@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly storage: StorageService,
  ) {}

  @Post('upload')
  @Throttle({ default: { limit: UPLOAD_THROTTLE_LIMIT, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File | undefined): Promise<UploadedAssetDto> {
    return this.assets.validateAndStore(file);
  }

  @Get(':id/file')
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const asset = await this.assets.findById(id);
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    this.storage.readStream(asset.storagePath).pipe(res);
  }

  /** Derives a new asset with the flat background removed; the source stays intact. */
  @Post(':id/remove-background')
  @Throttle({ default: { limit: UPLOAD_THROTTLE_LIMIT, ttl: 60_000 } })
  removeBackground(@Param('id', ParseUUIDPipe) id: string): Promise<UploadedAssetDto> {
    return this.assets.removeBackground(id);
  }

  /** Derives a new asset cropped to the given source-space rect; the source stays intact. */
  @Post(':id/crop')
  @Throttle({ default: { limit: UPLOAD_THROTTLE_LIMIT, ttl: 60_000 } })
  crop(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() rect: CropAssetDto,
  ): Promise<UploadedAssetDto> {
    return this.assets.crop(id, rect);
  }
}
