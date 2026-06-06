import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Shared app configuration applied both by main.ts and by the e2e test harness,
 * so tests exercise exactly what production runs.
 */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const config = app.get(ConfigService);
  const webOrigin = config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000';
  app.enableCors({
    origin: webOrigin.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST', 'PUT'],
    maxAge: 3600,
  });
}
