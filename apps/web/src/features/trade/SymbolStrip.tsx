import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { getMarketSocket } from '../../lib/ws';
import { T } from '../../design/tokens';
import { Tag } from '../../design/atoms';
import { fmtAbbr, fmtNum, fmtPct, priceDigits } from '../../design/tokens';

interface TradeRow { id: string; price: string; quantity: string; takerSide: 'BID' | 'ASK'; ts: number; }
interface CandleRow { openTime: number; high: string; low: string; close: string; volume: string; }

export function SymbolStrip({ symbol, baseAsset, quoteAsset }: {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}) {
  const [lastPrice, setLastPrice] = useState<number | null>(null);

  const { data: trades } = useQuery({
    queryKey: ['trades', symbol],
    queryFn: async () => (await api.get<TradeRow[]>(`/markets/${symbol}/trades`, { params: { limit: 1 } })).data,
  });
  const { data: candles } = useQuery({
    queryKey: ['candles24', symbol],
    queryFn: async () => (await api.get<CandleRow[]>(`/markets/${symbol}/candles`, { params: { interval: 'M1', limit: 1440 } })).data,
  });

  useEffect(() => {
    if (trades?.[0]) setLastPrice(Number(trades[0].price));
  }, [trades]);

  useEffect(() => {
    const sock = getMarketSocket();
    sock.emit('subscribe', { symbol });
    const h = (t: TradeRow & { market: string }) => {
      if (t.market === symbol) setLastPrice(Number(t.price));
    };
    sock.on('trade', h);
    return () => {
      sock.off('trade', h);
    };
  }, [symbol]);

  const high24 = candles?.length ? Math.max(...candles.map((c) => Number(c.high))) : null;
  const low24 = candles?.length ? Math.min(...candles.map((c) => Number(c.low))) : null;
  const firstClose = candles?.[0] ? Number(candles[0].close) : null;
  const chg24Pct =
    firstClose != null && lastPrice != null && firstClose > 0
      ? ((lastPrice - firstClose) / firstClose) * 100
      : null;
  const vol24Base = candles?.length ? candles.reduce((a, c) => a + Number(c.volume), 0) : null;
  const vol24Quote = vol24Base != null && lastPrice != null ? vol24Base * lastPrice : null;

  const up = (chg24Pct ?? 0) >= 0;
  const col = up ? T.up : T.down;
  const dig = priceDigits(lastPrice ?? 0);

  const stats = [
    { label: '24h 고가', value: high24 != null ? fmtNum(high24, dig) : '—' },
    { label: '24h 저가', value: low24 != null ? fmtNum(low24, dig) : '—' },
    {
      label: '24h 거래량',
      value: vol24Base != null ? `${vol24Base.toFixed(2)} ${baseAsset}` : '—',
    },
    {
      label: '24h 거래대금',
      value: vol24Quote != null ? `${quoteAsset === 'KRW' ? '₩' : ''}${fmtAbbr(vol24Quote)}` : '—',
    },
  ];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        padding: '12px 20px',
        borderBottom: `1px solid ${T.border}`,
        background: T.card,
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: T.brandSoft,
            color: T.brandInk,
            fontWeight: 800,
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            letterSpacing: 0.3,
          }}
        >
          {baseAsset}
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{symbol}</span>
            <Tag tone="brand">{quoteAsset === 'KRW' ? '원화' : quoteAsset}</Tag>
          </div>
          <div style={{ fontSize: 11.5, color: T.text3, marginTop: 2 }}>{baseAsset}</div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span
          style={{
            fontFamily: 'var(--font-num)',
            fontVariantNumeric: 'tabular-nums',
            fontSize: 26,
            fontWeight: 700,
            color: col,
            letterSpacing: -0.5,
          }}
        >
          {lastPrice != null ? fmtNum(lastPrice, dig) : '—'}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-num)',
            fontVariantNumeric: 'tabular-nums',
            fontSize: 13,
            fontWeight: 600,
            color: col,
          }}
        >
          {chg24Pct != null ? fmtPct(chg24Pct) : '—'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 24, marginLeft: 8 }}>
        {stats.map((s) => (
          <div key={s.label} style={{ whiteSpace: 'nowrap' }}>
            <div style={{ fontSize: 10.5, color: T.text3, letterSpacing: 0.3 }}>{s.label}</div>
            <div
              className="mono"
              style={{ fontSize: 12.5, fontWeight: 600, color: T.text, marginTop: 2 }}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
