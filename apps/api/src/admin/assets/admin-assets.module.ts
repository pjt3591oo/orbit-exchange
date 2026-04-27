import { Module } from '@nestjs/common';
import { AdminAssetsController } from './admin-assets.controller';
import { AdminAssetsService } from './admin-assets.service';

@Module({
  controllers: [AdminAssetsController],
  providers: [AdminAssetsService],
})
export class AdminAssetsModule {}
