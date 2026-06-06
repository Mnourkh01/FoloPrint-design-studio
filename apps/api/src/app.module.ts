import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AssetsModule } from './assets/assets.module';
import { DesignsModule } from './designs/designs.module';
import { FontsModule } from './fonts/fonts.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { TemplatesModule } from './templates/templates.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot({
      // Env-overridable so the e2e suite can exceed the human-scale default.
      throttlers: [{ ttl: 60_000, limit: Number(process.env.GLOBAL_THROTTLE_LIMIT ?? 120) }],
    }),
    PrismaModule,
    StorageModule,
    TemplatesModule,
    AssetsModule,
    DesignsModule,
    FontsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
