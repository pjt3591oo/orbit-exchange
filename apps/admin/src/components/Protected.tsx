import type { ReactNode } from 'react';
import { hasAnyRole } from '../lib/keycloak';

/**
 * Route guard. Renders children only if the current admin has any of the
 * required Keycloak realm roles. Otherwise renders a polite 403 message
 * (NOT a redirect — keeps URLs honest).
 */
export function Protected({
  roles,
  children,
}: {
  roles: string[];
  children: ReactNode;
}) {
  if (hasAnyRole(roles)) return <>{children}</>;
  return (
    <div style={{ padding: 32, color: 'var(--text-3)' }}>
      <h2 style={{ color: 'var(--text)', fontSize: 18, marginBottom: 12 }}>
        권한이 부족합니다
      </h2>
      <p>
        이 페이지에는 <code>{roles.join(' / ')}</code> 권한이 필요합니다. 운영 담당자에게
        문의해 주세요.
      </p>
    </div>
  );
}
