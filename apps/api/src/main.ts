import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { warmTextRenderer } from './warmup';

async function bootstrap(): Promise<void> {
  const app: INestApplication = await NestFactory.create(AppModule);
  configureApp(app);

  const config = app.get(ConfigService);
  const port = Number(config.get<string>('PORT') ?? 3001);

  // Pay the one-time Pango/fontconfig cold start before we accept requests, so
  // no render request (and no Playwright spec) ever eats it mid-flight.
  await warmTextRenderer();

  await app.listen(port);
  console.log(`FoloPrint Design Studio API listening on http://localhost:${port}`);
}

void bootstrap();
