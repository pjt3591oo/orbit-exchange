import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/current-user.decorator';

@Controller({ path: 'me', version: '1' })
@UseGuards(JwtAuthGuard)
export class UserController {
  @Get()
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
