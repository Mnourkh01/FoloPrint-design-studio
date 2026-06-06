import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok'; service: string; timestamp: string } {
    return {
      status: 'ok',
      service: 'foloprint-design-studio-api',
      timestamp: new Date().toISOString(),
    };
  }
}
