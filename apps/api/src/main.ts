import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app: INestApplication = await NestFactory.create(AppModule);
  configureApp(app);

  const config = app.get(ConfigService);
  const port = Number(config.get<string>('PORT') ?? 3001);

  // The text-renderer warmup runs in RenderWarmup's onApplicationBootstrap hook,
  // which app.listen() triggers before it binds the port (so /health readiness
  // still implies a warm renderer). One mechanism covers the server and the
  // Jest e2e app alike.
  await app.listen(port);
  console.log(`FoloPrint Design Studio API listening on http://localhost:${port}`);
}

void bootstrap();
