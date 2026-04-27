import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/current-user.decorator';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { OrderService } from './order.service';
import { CreateOrderDto } from './dto';

@Controller({ path: 'orders', version: '1' })
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  /**
   * Idempotency-Key (UUID v4) is OPTIONAL but strongly recommended for any
   * client that may retry on network errors. Without it, a retry produces a
   * duplicate Order with locked balance — recoverable only by manual
   * cancel. See ADR-0003 §D2.
   */
  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  submit(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    return this.orders.submit(user.userId, dto);
  }

  @Get('open')
  listOpen(@CurrentUser() user: AuthenticatedUser, @Query('market') market?: string) {
    return this.orders.listOpen(user.userId, market);
  }

  @Get('history')
  history(@CurrentUser() user: AuthenticatedUser, @Query('market') market?: string) {
    return this.orders.listHistory(user.userId, market);
  }

  @Delete(':id')
  @UseInterceptors(IdempotencyInterceptor)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) {
    return this.orders.cancel(user.userId, BigInt(id));
  }
}
