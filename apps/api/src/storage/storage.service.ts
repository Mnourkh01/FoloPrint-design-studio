import { BadRequestException, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream, type ReadStream } from 'node:fs';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

/**
 * The only place in the API that touches the filesystem layout.
 * All keys are relative ("uploads/<uuid>.png"); resolution is jailed to STORAGE_ROOT.
 * Swapping local disk for S3/R2 later means replacing this class.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('STORAGE_ROOT') ?? './storage');
  }

  async onModuleInit(): Promise<void> {
    for (const dir of ['templates', 'uploads', 'previews']) {
      await mkdir(join(this.root, dir), { recursive: true });
    }
  }

  /** Resolve a relative storage key to an absolute path, rejecting any escape attempt. */
  resolvePath(relativeKey: string): string {
    if (!relativeKey || isAbsolute(relativeKey)) {
      throw new BadRequestException('Invalid storage key');
    }
    const absolute = resolve(this.root, normalize(relativeKey));
    if (absolute !== this.root && !absolute.startsWith(this.root + sep)) {
      throw new BadRequestException('Invalid storage key');
    }
    return absolute;
  }

  async save(relativeKey: string, buffer: Buffer): Promise<void> {
    const absolute = this.resolvePath(relativeKey);
    // Keys may nest (e.g. previews/<designId>/<areaKey>.png); ensure the parent exists.
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, buffer);
  }

  async exists(relativeKey: string): Promise<boolean> {
    try {
      await access(this.resolvePath(relativeKey));
      return true;
    } catch {
      return false;
    }
  }

  readStream(relativeKey: string): ReadStream {
    return createReadStream(this.resolvePath(relativeKey));
  }

  /** Whole-file read for in-process image work (asset transforms). */
  read(relativeKey: string): Promise<Buffer> {
    return readFile(this.resolvePath(relativeKey));
  }

  /** Delete a stored file; a missing file is not an error (idempotent cleanup). */
  async remove(relativeKey: string): Promise<void> {
    try {
      await unlink(this.resolvePath(relativeKey));
    } catch {
      // already gone or never written; nothing to clean up
    }
  }
}
