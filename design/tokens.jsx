// tokens.jsx — design tokens, market data, helpers for ORBIT Exchange
// Light-mode fintech. Korean convention: up=red, down=blue.

const TOKENS_DEFAULT = {
  // neutrals
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
  // up/down (Korean default)
  up: '#E12D39',
  upBg: 'rgba(225,45,57,0.08)',
  upBgStrong: 'rgba(225,45,57,0.14)',
  down: '#1966D2',
  downBg: 'rgba(25,102,210,0.08)',
  downBgStrong: 'rgba(25,102,210,0.14)',
  // brand (oklch deep blue-violet)
  brand: 'oklch(0.55 0.18 260)',
  brandSoft: 'oklch(0.96 0.02 260)',
  brandInk: 'oklch(0.35 0.14 260)',
  // status
  warn: '#C28500',
  warnBg: 'rgba(194,133,0,0.10)',
  ok: '#1E8E5A',
  okBg: 'rgba(30,142,90,0.10)',
  // type
  fontBody: '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif',
  fontNum: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  // metrics
  radius: 10,
  radiusSm: 6,
  rowH: 36,
};

// tabular, signed number formatting
function fmtNum(n, digits = 2) {
  if (n == null || !isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
function fmtKRW(n) {
  if (n == null) return '—';
  return '₩' + Math.round(n).toLocaleString('en-US');
}
function fmtPct(n, digits = 2) {
  if (n == null) return '—';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(digits)}%`;
}
function fmtAbbr(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(0);
}

// Deterministic pseudo-random so a refresh feels stable
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fictional market (original symbols — NOT real coins)
// Prices roughly KRW-denominated.
const MARKETS = [
  { sym: 'ASTR', name: 'Astrix',       price: 48_230_000, chg24:  2.31, vol24: 284_300_000_000, favorite: true  },
  { sym: 'LUMI', name: 'Lumina',       price:  3_812_500, chg24: -1.22, vol24: 188_900_000_000, favorite: true  },
  { sym: 'KRON', name: 'Kronos',       price:    421_900, chg24:  5.88, vol24:  92_400_000_000, favorite: false },
  { sym: 'MESH', name: 'Meshnet',      price:     12_480, chg24: -0.42, vol24:  34_100_000_000, favorite: true  },
  { sym: 'NOVA', name: 'Nova',         price:    680_200, chg24:  7.13, vol24:  61_800_000_000, favorite: false },
  { sym: 'FLUX', name: 'Fluxion',      price:     95_410, chg24: -3.04, vol24:  22_600_000_000, favorite: false },
  { sym: 'VELA', name: 'Velara',       price:  1_246_800, chg24:  0.86, vol24:  45_500_000_000, favorite: false },
  { sym: 'ZEPH', name: 'Zephyr',       price:      4_125, chg24: -2.15, vol24:  12_900_000_000, favorite: false },
  { sym: 'ORCA', name: 'Orcaly',       price:    318_700, chg24:  4.02, vol24:  28_700_000_000, favorite: false },
  { sym: 'HALO', name: 'Halocore',     price:      8_934, chg24:  1.44, vol24:  15_300_000_000, favorite: true  },
  { sym: 'RUNE', name: 'Runechain',    price:     58_210, chg24: -0.58, vol24:  19_800_000_000, favorite: false },
  { sym: 'TERA', name: 'Teradyne',     price:  2_104_000, chg24:  3.27, vol24:  72_400_000_000, favorite: false },
  { sym: 'VEGA', name: 'Vega Protocol',price:     24_870, chg24: -4.91, vol24:   9_800_000_000, favorite: false },
  { sym: 'AXIS', name: 'Axiswap',      price:    141_200, chg24:  0.12, vol24:  17_200_000_000, favorite: false },
  { sym: 'BOLT', name: 'Boltnet',      price:      6_720, chg24:  8.76, vol24:  38_400_000_000, favorite: false },
  { sym: 'ECHO', name: 'Echogrid',     price:     87_430, chg24: -1.88, vol24:  11_600_000_000, favorite: false },
];

// Portfolio holdings (ORBIT original, not tied to any real exchange)
const HOLDINGS = [
  { sym: 'ASTR', qty: 0.4821,   avg: 44_120_000 },
  { sym: 'LUMI', qty: 12.3,     avg:  3_602_100 },
  { sym: 'NOVA', qty: 58.0,     avg:    712_800 },
  { sym: 'HALO', qty: 2140,     avg:      8_120 },
  { sym: 'KRON', qty: 31,       avg:    398_400 },
];

// Order book generator around a mid price
function buildOrderBook(mid, seed = 1) {
  const r = mulberry32(seed);
  const tick = mid > 1_000_000 ? 1000 : mid > 100_000 ? 100 : mid > 10_000 ? 10 : mid > 1_000 ? 1 : 0.5;
  const asks = [];
  const bids = [];
  for (let i = 0; i < 14; i++) {
    const p = mid + tick * (i + 1);
    const qty = (0.2 + r() * 4) * (1 + i * 0.08);
    asks.push({ price: p, qty });
  }
  for (let i = 0; i < 14; i++) {
    const p = mid - tick * (i + 1);
    const qty = (0.2 + r() * 4) * (1 + i * 0.08);
    bids.push({ price: p, qty });
  }
  return { asks: asks.reverse(), bids };
}

// Candle series generator (synthetic)
function buildCandles(seed = 1, n = 96, base = 48_000_000) {
  const r = mulberry32(seed);
  let p = base;
  const out = [];
  for (let i = 0; i < n; i++) {
    const drift = (r() - 0.48) * base * 0.012;
    const open = p;
    const close = p + drift;
    const high = Math.max(open, close) + r() * base * 0.006;
    const low  = Math.min(open, close) - r() * base * 0.006;
    out.push({ open, close, high, low, vol: 0.5 + r() * 2 });
    p = close;
  }
  return out;
}

// Recent trades tape
function buildTape(seed = 2, mid = 48_230_000) {
  const r = mulberry32(seed);
  const out = [];
  let t = Date.now();
  for (let i = 0; i < 20; i++) {
    t -= Math.floor(2000 + r() * 8000);
    const side = r() > 0.48 ? 'buy' : 'sell';
    const tick = mid > 1_000_000 ? 1000 : 100;
    const price = mid + (r() - 0.5) * tick * 10;
    const qty = (0.005 + r() * 0.2);
    out.push({ t, side, price, qty });
  }
  return out;
}

Object.assign(window, {
  TOKENS_DEFAULT, MARKETS, HOLDINGS,
  fmtNum, fmtKRW, fmtPct, fmtAbbr,
  mulberry32, buildOrderBook, buildCandles, buildTape,
});
