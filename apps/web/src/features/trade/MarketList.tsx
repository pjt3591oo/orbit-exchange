import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { T, fmtNum, fmtPct, priceDigits } from '../../design/tokens';
import { Chip, IconSearch, IconStar } from '../../design/atoms';

interface MarketRow {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  takerFeeBp: number;
}
interface TickerRow { market: string; price: number; chg24: number; }

// Pull last trade + 24h open from candles for each market to compute chg24.
// MVP: fetch markets once, then per-market price via /trades?limit=1.
export function MarketList({ selected }: { selected: string }) {
  const nav = useNavigate();
  const [tab, setTab] = useState<'관심' | 'KRW' | 'BTC' | 'USDT'>('KRW');
  const [q, setQ] = useState('');

  const { data: markets } = useQuery({
    queryKey: ['markets'],
    queryFn: async () => (await api.get<MarketRow[]>('/markets')).data,
  });

  const symbols = useMemo(() => markets?.map((m) => m.symbol) ?? [], [markets]);

  const { data: tickers } = useQuery({
    queryKey: ['tickers', symbols.join(',')],
    enabled: symbols.length > 0,
    refetchInterval: 5000,
    queryFn: async () => {
      const rows = await Promise.all(
        symbols.map(async (sym): Promise<TickerRow> => {
          const [trade, candles] = await Promise.all([
            api.get<Array<{ price: string }>>(`/markets/${sym}/trades`, { params: { limit: 1 } }).then((r) => r.data[0]),
            api.get<Array<{ close: string }>>(`/markets/${sym}/candles`, {
              params: { interval: 'M1', limit: 1440 },
            }).then((r) => r.data),
          ]);
          const price = trade ? Number(trade.price) : 0;
          const first = candles.length ? Number(candles[0].close) : price;
          const chg24 = first > 0 ? ((price - first) / first) * 100 : 0;
          return { market: sym, price, chg24 };
        }),
      );
      return rows;
    },
  });

  const tickerMap = useMemo(() => {
    const m = new Map<string, TickerRow>();
    (tickers ?? []).forEach((t) => m.set(t.market, t));
    return m;
  }, [tickers]);

  const rows = useMemo(() => {
    const list = (markets ?? []).filter((m) => {
      if (tab !== '관심' && m.quoteAsset !== tab) return false;
      if (q && !(m.symbol + m.baseAsset).toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    return list;
  }, [markets, tab, q]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.card }}>
      <div
        style={{
          display: 'flex',
          gap: 2,
          padding: '10px 12px 6px',
          borderBottom: `1px solid ${T.borderSoft}`,
        }}
      >
        {(['관심', 'KRW', 'BTC', 'USDT'] as const).map((t) => (
          <Chip key={t} active={tab === t} onClick={() => setTab(t)}>
            {t}
          </Chip>
        ))}
      </div>

      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${T.borderSoft}` }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: T.bg,
            borderRadius: 6,
            padding: '6px 8px',
          }}
        >
          <IconSearch size={12} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="종목 검색"
            style={{
              flex: 1,
              border: 'none',
              background: 'transparent',
              outline: 'none',
              fontSize: 12,
              color: T.text,
            }}
          />
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '16px 1fr 86px 68px',
          gap: 8,
          padding: '6px 12px',
          fontSize: 10.5,
          color: T.text3,
          fontWeight: 600,
          borderBottom: `1px solid ${T.borderSoft}`,
          letterSpacing: 0.2,
        }}
      >
        <span></span>
        <span>종목</span>
        <span style={{ textAlign: 'right' }}>현재가</span>
        <span style={{ textAlign: 'right' }}>24h</span>
      </div>

      <div style={{ overflow: 'auto', flex: 1 }}>
        {rows.map((m) => {
          const tk = tickerMap.get(m.symbol);
          const col = (tk?.chg24 ?? 0) >= 0 ? T.up : T.down;
          const active = m.symbol === selected;
          return (
            <div
              key={m.symbol}
              onClick={() => nav(`/trade/${m.symbol}`)}
              style={{
                display: 'grid',
                gridTemplateColumns: '16px 1fr 86px 68px',
                gap: 8,
                alignItems: 'center',
                height: 38,
                padding: '0 12px',
                cursor: 'pointer',
                background: active ? T.brandSoft : 'transparent',
                borderLeft: active ? `2px solid ${T.brand}` : '2px solid transparent',
                paddingLeft: active ? 10 : 12,
                fontSize: 12,
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = T.hover;
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = 'transparent';
              }}
            >
              <IconStar color={T.text4} />
              <div style={{ overflow: 'hidden' }}>
                <div style={{ color: T.text, fontWeight: 600, lineHeight: 1.1 }}>{m.baseAsset}</div>
                <div
                  style={{
                    color: T.text3,
                    fontSize: 10.5,
                    lineHeight: 1.2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {m.symbol}
                </div>
              </div>
              <div
                className="mono"
                style={{ textAlign: 'right', color: T.text, fontWeight: 500 }}
              >
                {tk ? fmtNum(tk.price, priceDigits(tk.price)) : '—'}
              </div>
              <div
                className="mono"
                style={{ textAlign: 'right', color: col, fontWeight: 600, fontSize: 11.5 }}
              >
                {tk ? fmtPct(tk.chg24) : '—'}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div
            style={{
              padding: 20,
              textAlign: 'center',
              color: T.text3,
              fontSize: 12,
            }}
          >
            종목이 없습니다
          </div>
        )}
      </div>
    </div>
  );
}
