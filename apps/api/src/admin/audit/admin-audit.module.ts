import { Global, Module } from '@nestjs/common';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditInterceptor } from './admin-audit.interceptor';

@Global()
@Module({
  providers: [AdminAuditService, AdminAuditInterceptor],
  exports: [AdminAuditService, AdminAuditInterceptor],
})
export class AdminAuditModule {}
