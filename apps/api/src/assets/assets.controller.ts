import {
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
import type { Response } from 'express';
import type { UploadedAssetDto } from '@foloprint/shared';
import { memoryStorage } from 'multer';
import { AssetsService } from './assets.service';
import { StorageService } from '../storage/storage.service';

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024);

@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly storage: StorageService,
  ) {}

  @Post('upload')
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
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
}
