import { Module } from '@nestjs/common';
import { AdminWalletsController } from './admin-wallets.controller';
import { AdminWalletsService } from './admin-wallets.service';

@Module({
  controllers: [AdminWalletsController],
  providers: [AdminWalletsService],
  exports: [AdminWalletsService],
})
export class AdminWalletsModule {}
