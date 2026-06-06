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

  await app.listen(port);
  console.log(`FoloPrint Design Studio API listening on http://localhost:${port}`);
}

void bootstrap();
