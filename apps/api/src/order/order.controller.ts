import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/current-user.decorator';
import { OrderService } from './order.service';
import { CreateOrderDto } from './dto';

@Controller({ path: 'orders', version: '1' })
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  @Post()
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
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) {
    return this.orders.cancel(user.userId, BigInt(id));
  }
}
