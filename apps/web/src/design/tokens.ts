// Design tokens — mirrors design/tokens.jsx (TOKENS_DEFAULT).
// Korean convention: up = red, down = blue.
export const T = {
  bg: '#F6F7F9',
  bgAlt: '#FAFBFC',
  card: '#FFFFFF',
  border: '#E8EBEF',
  borderSoft: '#EEF0F3',
  hover: '#F2F4F7',
  text: '#0E1116',
  text2: '#4A5561',
  text3: '#7D8793',
  text4: '#B1B8C2',
  up: '#E12D39',
  upBg: 'rgba(225,45,57,0.08)',
  upBgStrong: 'rgba(225,45,57,0.14)',
  down: '#1966D2',
  downBg: 'rgba(25,102,210,0.08)',
  downBgStrong: 'rgba(25,102,210,0.14)',
  brand: 'oklch(0.55 0.18 260)',
  brandSoft: 'oklch(0.96 0.02 260)',
  brandInk: 'oklch(0.35 0.14 260)',
  warn: '#C28500',
  warnBg: 'rgba(194,133,0,0.10)',
  ok: '#1E8E5A',
  okBg: 'rgba(30,142,90,0.10)',
  fontBody: 'var(--font-body)',
  fontNum: 'var(--font-num)',
  radius: 10,
  radiusSm: 6,
  rowH: 36,
} as const;

export function fmtNum(n: number | string | null | undefined, digits = 2): string {
  if (n == null) return '—';
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtKRW(n: number | string | null | undefined): string {
  if (n == null) return '—';
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return '—';
  return '₩' + Math.round(v).toLocaleString('en-US');
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(digits)}%`;
}

export function fmtAbbr(n: number | null | undefined): string {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(0);
}

export function priceDigits(price: number): number {
  if (price < 1) return 4;
  if (price < 100) return 2;
  return 0;
}
