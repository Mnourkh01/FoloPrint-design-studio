import { createReadStream } from 'node:fs';
import { Controller, Get, Header, NotFoundException, Param, StreamableFile } from '@nestjs/common';
import { resolveFont, UnknownFontError } from '@foloprint/renderer';

/**
 * Streams the bundled whitelist fonts to the editor so the browser measures text
 * with EXACTLY the file the server renders with. Keys come from the shared
 * whitelist; anything else is a 404 (never a path lookup). The fonts are package
 * assets owned by the renderer, not user uploads, so they bypass StorageService.
 */
@Controller('fonts')
export class FontsController {
  @Get(':key/file')
  @Header('Content-Type', 'font/ttf')
  @Header('Cache-Control', 'public, max-age=86400')
  file(@Param('key') key: string): StreamableFile {
    try {
      const font = resolveFont(key);
      return new StreamableFile(createReadStream(font.filePath));
    } catch (error) {
      if (error instanceof UnknownFontError) {
        throw new NotFoundException(`Font "${key}" not found`);
      }
      throw error;
    }
  }
}
