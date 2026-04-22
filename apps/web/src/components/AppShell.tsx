import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { T } from '../design/tokens';
import { IconBell, IconSearch, Logo } from '../design/atoms';
import { AlertsDropdown } from './AlertsDropdown';
import { useBreakpoint } from '../hooks/useBreakpoint';

const TABS: Array<{ label: string; to: string; match?: RegExp }> = [
  { label: '거래소', to: '/trade/BTC-KRW', match: /^\/trade(\/|$)/ },
  { label: '포트폴리오', to: '/portfolio' },
  { label: '입출금', to: '/deposit' },
  { label: '스테이킹', to: '/staking' },
  { label: '공지', to: '/notices' },
];

export function AppShell() {
  const { email, clear } = useAuthStore();
  const nav = useNavigate();
  const location = useLocation();
  const bp = useBreakpoint();
  const [bellOpen, setBellOpen] = useState(false);
  const initials = (email ?? 'JY')
    .replace(/@.*$/, '')
    .slice(0, 2)
    .toUpperCase();

  const isTabActive = (tab: (typeof TABS)[number]) =>
    tab.match ? tab.match.test(location.pathname) : location.pathname === tab.to;

  const showSearch = bp === 'desktop';
  const compactHeader = bp !== 'desktop';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: T.bg }}>
      {/* TopBar */}
      <div
        style={{
          height: 52,
          display: 'flex',
          alignItems: 'center',
          padding: compactHeader ? '0 12px' : '0 20px',
          borderBottom: `1px solid ${T.border}`,
          background: T.card,
          gap: compactHeader ? 12 : 32,
          flexShrink: 0,
        }}
      >
        <NavLink
          to="/"
          style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}
        >
          <Logo size={22} color={T.brand} />
          <span style={{ fontWeight: 800, fontSize: 15, letterSpacing: 0.5, color: T.text }}>
            ORBIT
          </span>
          {bp === 'desktop' && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: T.text3,
                letterSpacing: 1,
                marginLeft: 2,
              }}
            >
              EXCHANGE
            </span>
          )}
        </NavLink>

        <div
          style={{
            display: 'flex',
            gap: 4,
            overflowX: 'auto',
            flex: compactHeader ? 1 : undefined,
            minWidth: 0,
            // hide native scrollbar on the tab row — overflow still works via swipe / trackpad.
            scrollbarWidth: 'none',
          }}
        >
          {TABS.map((t) => {
            const active = isTabActive(t);
            return (
              <Link
                key={t.label}
                to={t.to}
                style={{
                  textDecoration: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                  color: active ? T.text : T.text2,
                  padding: '6px 10px',
                  whiteSpace: 'nowrap',
                  borderBottom: active ? `2px solid ${T.brand}` : '2px solid transparent',
                  marginBottom: -2,
                  flexShrink: 0,
                }}
              >
                {t.label}
              </Link>
            );
          })}
        </div>

        {showSearch && (
          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: T.hover,
              borderRadius: 8,
              padding: '6px 10px',
              width: 220,
              color: T.text3,
              fontSize: 12.5,
              flexShrink: 0,
            }}
          >
            <IconSearch size={14} color={T.text3} />
            <span>심볼 검색…</span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 10,
                fontWeight: 700,
                background: T.card,
                color: T.text2,
                padding: '2px 5px',
                borderRadius: 3,
                border: `1px solid ${T.border}`,
              }}
            >
              ⌘K
            </span>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            position: 'relative',
            marginLeft: showSearch ? 0 : 'auto',
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setBellOpen((v) => !v)}
            style={{
              width: 30,
              height: 30,
              border: `1px solid ${T.border}`,
              background: T.card,
              borderRadius: 6,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
            }}
            aria-label="알림"
            aria-expanded={bellOpen}
          >
            <IconBell />
            <span
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: T.up,
                boxShadow: `0 0 0 1.5px ${T.card}`,
              }}
            />
          </button>
          {bellOpen && <AlertsDropdown onClose={() => setBellOpen(false)} />}
          {email ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                title={email}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: T.brand,
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {initials}
              </div>
              <button
                onClick={() => {
                  clear();
                  nav('/login');
                }}
                title="로그아웃"
                aria-label="로그아웃"
                style={{
                  background: 'transparent',
                  border: `1px solid ${T.border}`,
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  color: T.text2,
                  padding: bp === 'mobile' ? '5px 8px' : '6px 10px',
                  cursor: 'pointer',
                }}
              >
                {bp === 'mobile' ? '↩' : '로그아웃'}
              </button>
            </div>
          ) : (
            <button
              onClick={() => nav('/login')}
              style={{
                background: T.text,
                color: '#fff',
                border: 'none',
                fontFamily: 'inherit',
                fontSize: 12.5,
                fontWeight: 700,
                padding: '7px 14px',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              로그인
            </button>
          )}
        </div>
      </div>
      <main style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0 }}>
        <Outlet />
      </main>
    </div>
  );
}
