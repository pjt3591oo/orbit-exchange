import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { getMarketSocket } from '../../lib/ws';
import { T, fmtNum, fmtPct, priceDigits } from '../../design/tokens';
import { Chip, IconSearch, IconStar } from '../../design/atoms';

interface MarketRow {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  takerFeeBp: number;
}
interface TickerRow { market: string; price: number; chg24: number; }

// Live tick state per market — populated by WS trade events. The price here
// overrides the polled ticker so updates feel instant. `dir` records whether
// the latest trade ticked up/down/flat vs the previous live price; `ver` is
// a monotonic counter that lets a CSS animation re-trigger on each tick.
interface LiveTick { price: number; dir: 'up' | 'down' | 'flat'; ver: number }

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

  // Live last-trade price per market via WS. We subscribe to every market in
  // the registry (not just the selected one) so the side panel reflects
  // matches across the board the moment they happen. The 5s ticker poll is
  // still the source of truth for chg24.
  const [liveTicks, setLiveTicks] = useState<Record<string, LiveTick>>({});
  // Track the previous live price in a ref so back-to-back trades within one
  // React render still produce a meaningful direction.
  const lastPriceRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (symbols.length === 0) return;
    const sock = getMarketSocket();
    // Trade-only subscription. We don't want this side panel to also pull
    // an orderbook snapshot back per symbol — that would clobber the trade
    // page's populated orderbook with an empty payload whenever the Redis
    // snapshot key happens to be missing.
    symbols.forEach((sym) => sock.emit('subscribe', { symbol: sym, kind: 'trade' }));

    const handler = (t: { market: string; price: string }) => {
      const newPrice = Number(t.price);
      if (!Number.isFinite(newPrice) || newPrice <= 0) return;
      const prev = lastPriceRef.current[t.market];
      const dir: 'up' | 'down' | 'flat' =
        prev === undefined || prev === newPrice
          ? 'flat'
          : newPrice > prev
            ? 'up'
            : 'down';
      lastPriceRef.current[t.market] = newPrice;
      setLiveTicks((cur) => ({
        ...cur,
        [t.market]: { price: newPrice, dir, ver: (cur[t.market]?.ver ?? 0) + 1 },
      }));
    };
    sock.on('trade', handler);
    return () => {
      sock.off('trade', handler);
    };
  }, [symbols.join(',')]);

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
          const live = liveTicks[m.symbol];
          // Live trade price overrides the 5s polled price as soon as we
          // receive any tick.
          const price = live?.price ?? tk?.price;
          const chg24 = tk?.chg24 ?? 0;
          const chgCol = chg24 >= 0 ? T.up : T.down;
          // Price text colour: most-recent tick direction wins (so the user
          // sees red/blue the instant a trade lands). When there's been no
          // tick yet, fall back to the 24h change colour so the column is
          // never a meaningless black.
          const priceCol =
            live?.dir === 'up'
              ? T.up
              : live?.dir === 'down'
                ? T.down
                : chgCol;
          const active = m.symbol === selected;
          return (
            <div
              key={m.symbol}
              onClick={() => nav(`/trade/${m.symbol}`)}
              style={{
                position: 'relative',
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
              {/* Trade-tick flash. `key={ver}` remounts the element on every
                  trade so the 700ms fade-out animation plays each time. */}
              {live && live.dir !== 'flat' && (
                <div
                  key={live.ver}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: live.dir === 'up' ? T.upBg : T.downBg,
                    animation: 'orbitTickFlash 700ms ease-out forwards',
                    pointerEvents: 'none',
                  }}
                />
              )}
              <IconStar color={T.text4} />
              <div style={{ overflow: 'hidden', position: 'relative' }}>
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
                style={{ textAlign: 'right', color: priceCol, fontWeight: 600, position: 'relative' }}
              >
                {price != null ? fmtNum(price, priceDigits(price)) : '—'}
              </div>
              <div
                className="mono"
                style={{ textAlign: 'right', color: chgCol, fontWeight: 600, fontSize: 11.5, position: 'relative' }}
              >
                {tk ? fmtPct(chg24) : '—'}
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
