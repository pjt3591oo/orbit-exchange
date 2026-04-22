import { Controller, Get, Module } from '@nestjs/common';

@Controller({ path: 'health', version: '1' })
class HealthController {
  @Get() check() { return { ok: true, ts: Date.now() }; }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
