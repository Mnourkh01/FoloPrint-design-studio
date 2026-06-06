import { Module } from '@nestjs/common';
import { FontsController } from './fonts.controller';

@Module({
  controllers: [FontsController],
})
export class FontsModule {}
