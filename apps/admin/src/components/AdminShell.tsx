import { NavLink, Outlet } from 'react-router-dom';
import { profile, logout, hasAnyRole } from '../lib/keycloak';

const NAV: Array<{ to: string; label: string; roles?: string[] }> = [
  { to: '/dashboard', label: '대시보드' },
  { to: '/users', label: '사용자', roles: ['SUPPORT_READ'] },
  { to: '/markets', label: '마켓', roles: ['SUPPORT_READ'] },
  { to: '/orders', label: '주문', roles: ['SUPPORT_READ'] },
  { to: '/trades', label: '체결', roles: ['SUPPORT_READ'] },
  { to: '/assets', label: '자산', roles: ['MARKET_OPS'] },
  { to: '/audit', label: '감사로그', roles: ['AUDITOR', 'SUPPORT_READ'] },
];

export function AdminShell() {
  const me = profile();
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <aside
        style={{
          width: 200,
          borderRight: '1px solid var(--border)',
          background: 'var(--card)',
          display: 'flex',
          flexDirection: 'column',
          padding: '16px 0',
        }}
      >
        <div style={{ padding: '0 16px 16px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>ORBIT Admin</div>
          <div style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 2 }}>
            {me.email ?? me.username}
          </div>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {me.realmRoles.map((r) => (
              <span
                key={r}
                style={{
                  fontSize: 9.5,
                  padding: '1px 5px',
                  borderRadius: 3,
                  background: 'var(--brand-soft)',
                  color: 'var(--brand-ink)',
                  fontWeight: 600,
                }}
              >
                {r}
              </span>
            ))}
          </div>
        </div>
        <nav style={{ flex: 1, padding: '12px 8px' }}>
          {NAV.filter((n) => !n.roles || hasAnyRole(n.roles)).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              style={({ isActive }) => ({
                display: 'block',
                padding: '8px 12px',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
                color: isActive ? 'var(--brand-ink)' : 'var(--text-2)',
                background: isActive ? 'var(--brand-soft)' : 'transparent',
                marginBottom: 2,
              })}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={() => logout()}
          style={{
            margin: 12,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'transparent',
            fontSize: 12,
          }}
        >
          로그아웃
        </button>
      </aside>
      <main style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}
