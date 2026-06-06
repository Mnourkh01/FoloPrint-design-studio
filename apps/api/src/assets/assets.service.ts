import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { UploadedAsset } from '@prisma/client';
import type { UploadedAssetDto } from '@foloprint/shared';
import { FlatBackgroundError, removeFlatBackground } from '@foloprint/renderer';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

/** Real formats we accept, mapped to the extension and MIME we store. */
const ALLOWED_FORMATS: Record<string, { ext: string; mime: string }> = {
  png: { ext: 'png', mime: 'image/png' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
};

const MIN_IMAGE_DIMENSION = 16;

/** Defensive cap against decompression bombs before full decode. */
const MAX_INPUT_PIXELS = 50_000_000;

@Injectable()
export class AssetsService {
  private readonly maxImageDimension: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.maxImageDimension = Number(config.get<string>('MAX_IMAGE_DIMENSION') ?? 6000);
  }

  /**
   * Validates by REAL bytes (sharp/libvips format sniffing), never by extension or the
   * client-declared MIME. The stored file is a full re-encode: strips metadata and any
   * payload appended to the original bytes.
   */
  async validateAndStore(file: Express.Multer.File | undefined): Promise<UploadedAssetDto> {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('No file uploaded. Send a PNG or JPEG as field "file".');
    }

    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(file.buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    } catch {
      throw new BadRequestException('File is not a valid image.');
    }

    const format = metadata.format ? ALLOWED_FORMATS[metadata.format] : undefined;
    if (!format) {
      throw new BadRequestException(
        `Unsupported image format "${metadata.format ?? 'unknown'}". Only PNG and JPEG are allowed.`,
      );
    }

    const { width, height } = metadata;
    if (!width || !height || width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION) {
      throw new BadRequestException(`Image must be at least ${MIN_IMAGE_DIMENSION}x${MIN_IMAGE_DIMENSION}px.`);
    }
    if (width > this.maxImageDimension || height > this.maxImageDimension) {
      throw new BadRequestException(
        `Image dimensions exceed the ${this.maxImageDimension}px limit (got ${width}x${height}).`,
      );
    }

    // Re-encode: applies EXIF orientation, strips metadata, neutralizes appended payloads.
    const pipeline = sharp(file.buffer, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
    const encoded =
      format.ext === 'png'
        ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
        : await pipeline.jpeg({ quality: 92 }).toBuffer();

    // EXIF orientations 5-8 rotate by 90/270: the re-encoded file has swapped
    // dimensions versus the pre-rotate metadata. Store the dimensions of the bytes
    // we actually keep; DPI math downstream depends on them being right.
    const orientation = metadata.orientation ?? 1;
    const [storedWidth, storedHeight] = orientation >= 5 ? [height, width] : [width, height];

    const id = randomUUID();
    const storagePath = `uploads/${id}.${format.ext}`;
    await this.storage.save(storagePath, encoded);

    const asset = await this.prisma.uploadedAsset.create({
      data: {
        id,
        originalFilename: this.sanitizeFilename(file.originalname),
        mimeType: format.mime,
        sizeBytes: encoded.length,
        width: storedWidth,
        height: storedHeight,
        storagePath,
      },
    });

    return this.toDto(asset);
  }

  async findById(id: string): Promise<UploadedAsset> {
    const asset = await this.prisma.uploadedAsset.findUnique({ where: { id } });
    if (!asset) {
      throw new NotFoundException(`Asset "${id}" not found`);
    }
    return asset;
  }

  /**
   * Derives a NEW asset with the flat background removed (flood fill from the
   * border; see the renderer util). The source asset is never mutated, so the
   * editor can always swap back. A busy/photographic background maps to a 400
   * with the renderer's human-readable reason.
   */
  async removeBackground(id: string): Promise<UploadedAssetDto> {
    const source = await this.findById(id);
    const bytes = await this.storage.read(source.storagePath);

    let png: Buffer;
    try {
      ({ png } = await removeFlatBackground(bytes));
    } catch (error) {
      if (error instanceof FlatBackgroundError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    // Always PNG (alpha required), dimensions read from the produced bytes.
    const meta = await sharp(png).metadata();
    const newId = randomUUID();
    const storagePath = `uploads/${newId}.png`;
    await this.storage.save(storagePath, png);

    const derived = await this.prisma.uploadedAsset.create({
      data: {
        id: newId,
        originalFilename: this.derivedFilename(source.originalFilename),
        mimeType: 'image/png',
        sizeBytes: png.length,
        width: meta.width ?? source.width,
        height: meta.height ?? source.height,
        storagePath,
      },
    });

    return this.toDto(derived);
  }

  /** "logo.png" -> "logo-nobg.png"; keeps the sanitizer's character set. */
  private derivedFilename(original: string): string {
    const stem = original.replace(/\.(png|jpe?g)$/i, '');
    return this.sanitizeFilename(`${stem}-nobg.png`);
  }

  /** Display-only name: path stripped, control/special characters removed, length-capped. */
  private sanitizeFilename(name: string | undefined): string {
    const base = basename(name ?? '').replace(/[^a-zA-Z0-9 ._()-]/g, '');
    const trimmed = base.replace(/\s+/g, ' ').trim().slice(0, 100);
    return trimmed.length > 0 ? trimmed : 'upload';
  }

  private toDto(asset: UploadedAsset): UploadedAssetDto {
    return {
      id: asset.id,
      originalFilename: asset.originalFilename,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      width: asset.width,
      height: asset.height,
      url: `/assets/${asset.id}/file`,
    };
  }
}
