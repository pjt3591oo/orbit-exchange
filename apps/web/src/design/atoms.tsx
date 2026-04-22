import { CSSProperties, ReactNode } from 'react';
import { T } from './tokens';

/**
 * ORBIT — tilted ring monogram (original mark from design/desktop.jsx).
 */
export function Logo({ size = 20, color = T.brand }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block' }}>
      <ellipse
        cx="12"
        cy="12"
        rx="10"
        ry="5"
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        transform="rotate(-28 12 12)"
      />
      <circle cx="12" cy="12" r="2.6" fill={color} />
    </svg>
  );
}

export function Chip({
  children,
  active,
  onClick,
  style,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 'none',
        background: active ? T.text : 'transparent',
        color: active ? '#fff' : T.text2,
        fontFamily: 'inherit',
        fontSize: 12,
        fontWeight: 600,
        padding: '6px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

type Tone = 'neutral' | 'up' | 'down' | 'brand' | 'warn' | 'ok';

const toneMap: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: T.hover, fg: T.text2 },
  up: { bg: T.upBg, fg: T.up },
  down: { bg: T.downBg, fg: T.down },
  brand: { bg: T.brandSoft, fg: T.brandInk },
  warn: { bg: T.warnBg, fg: T.warn },
  ok: { bg: T.okBg, fg: T.ok },
};

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  const c = toneMap[tone];
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        fontSize: 10.5,
        fontWeight: 700,
        padding: '2px 6px',
        borderRadius: 4,
        letterSpacing: 0.2,
        textTransform: 'uppercase',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function IconSearch({ size = 14, color = T.text3 }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke={color} strokeWidth="1.4" />
      <path d="M10.5 10.5L13.5 13.5" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconStar({ filled, size = 12, color }: { filled?: boolean; size?: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12">
      <path
        d="M6 1.2l1.55 3.14 3.47.5-2.51 2.45.59 3.45L6 9.1l-3.1 1.64.59-3.45L.98 4.84l3.47-.5L6 1.2z"
        fill={filled ? color : 'none'}
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconBell({ size = 14, color = T.text2 }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M4 7a4 4 0 018 0v3l1 2H3l1-2V7z"
        stroke={color}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6.5 13.5a1.5 1.5 0 003 0" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function sideTabStyle(active: boolean, col: string): CSSProperties {
  return {
    border: 'none',
    background: active ? col : 'transparent',
    color: active ? '#fff' : T.text2,
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 700,
    padding: '10px 0',
    cursor: 'pointer',
    borderBottom: active ? `2px solid ${col}` : '2px solid transparent',
  };
}
