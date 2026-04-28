import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { getMarketSocket } from '../../lib/ws';
import { T, fmtNum, priceDigits } from '../../design/tokens';
import { Chip } from '../../design/atoms';

interface Level { price: string; quantity: string; }
interface Snapshot { asks: Level[]; bids: Level[]; }

export function OrderbookPanel({
  symbol,
  quoteAsset,
  onPickPrice,
}: {
  symbol: string;
  quoteAsset: string;
  onPickPrice: (price: string) => void;
}) {
  const [snap, setSnap] = useState<Snapshot>({ asks: [], bids: [] });

  useQuery({
    queryKey: ['ob', symbol],
    queryFn: async () => {
      const { data } = await api.get<Snapshot>(`/markets/${symbol}/orderbook`);
      setSnap(data);
      return data;
    },
  });

  useEffect(() => {
    const sock = getMarketSocket();
    sock.emit('subscribe', { symbol });
    const handler = (d: Snapshot & { symbol: string }) => {
      if (d.symbol === symbol) setSnap({ asks: d.asks ?? [], bids: d.bids ?? [] });
    };
    sock.on('orderbook', handler);
    return () => {
      sock.off('orderbook', handler);
    };
  }, [symbol]);

  // Display cap. Korean exchange convention is 15 levels per side; this also
  // matches the visible-without-scrolling budget given the orderbook's grid
  // track height. Anything beyond gets clipped — `justifyContent: flex-end`
  // on asks anchors the best (lowest) asks just above the mid bar, and bids
  // anchor to the top so the best (highest) bid sits right below mid. The
  // levels that get clipped are always the LEAST informative (farthest from
  // mid), so the clip is intentional, not lossy.
  const VISIBLE_LEVELS = 15;

  // asks: descending (high→low) so top row is the highest ask, bottom row (just above mid) is the best (lowest) ask.
  // bids: descending too — the best (highest) bid sits right below mid.
  const asks = useMemo(
    () =>
      [...snap.asks]
        .sort((a, b) => Number(b.price) - Number(a.price))
        .slice(-VISIBLE_LEVELS), // last N = best (lowest) asks near mid
    [snap.asks],
  );
  const bids = useMemo(
    () =>
      [...snap.bids]
        .sort((a, b) => Number(b.price) - Number(a.price))
        .slice(0, VISIBLE_LEVELS), // first N = best (highest) bids near mid
    [snap.bids],
  );
  const mid =
    asks.length && bids.length
      ? (Number(asks[asks.length - 1].price) + Number(bids[0].price)) / 2
      : asks.length
        ? Number(asks[asks.length - 1].price)
        : bids.length
          ? Number(bids[0].price)
          : null;

  // Bar width = (this level's qty) / (sum of all qty on this side) * 100%.
  // So each side's bars together add up to 100% — the bar literally shows
  // "what share of the side this single level represents". Levels stay in
  // their natural price order; no cumulative effect.
  const totalAskQty = useMemo(
    () => snap.asks.reduce((s, l) => s + Number(l.quantity), 0),
    [snap.asks],
  );
  const totalBidQty = useMemo(
    () => snap.bids.reduce((s, l) => s + Number(l.quantity), 0),
    [snap.bids],
  );

  const dig = mid ? priceDigits(mid) : 0;

  const Row = ({ side, r, pct }: { side: 'ask' | 'bid'; r: Level; pct: number }) => {
    const isAsk = side === 'ask';
    const col = isAsk ? T.down : T.up; // Korean orderbook: ask=blue, bid=red
    const bg = isAsk ? T.downBg : T.upBg;
    const sum = Number(r.price) * Number(r.quantity);
    return (
      <div
        onClick={() => onPickPrice(r.price)}
        style={{
          position: 'relative',
          height: 24,
          cursor: 'pointer',
          fontFamily: 'var(--font-num)',
          fontVariantNumeric: 'tabular-nums',
          fontSize: 11.5,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: `${pct}%`,
            background: bg,
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            alignItems: 'center',
            padding: '0 12px',
          }}
        >
          <span style={{ color: col, fontWeight: 600 }}>{fmtNum(r.price, dig)}</span>
          <span style={{ color: T.text, textAlign: 'right' }}>{Number(r.quantity).toFixed(4)}</span>
          <span style={{ color: T.text3, textAlign: 'right' }}>{fmtNum(sum, 0)}</span>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.card }}>
      <div
        style={{
          padding: '8px 12px',
          borderBottom: `1px solid ${T.borderSoft}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>호가</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <Chip style={{ padding: '3px 6px', fontSize: 10.5 }}>0.01</Chip>
          <Chip active style={{ padding: '3px 6px', fontSize: 10.5 }}>1</Chip>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          padding: '8px 12px',
          fontSize: 10,
          color: T.text3,
          fontWeight: 600,
          letterSpacing: 0.3,
          borderBottom: `1px solid ${T.borderSoft}`,
        }}
      >
        <span>가격({quoteAsset})</span>
        <span style={{ textAlign: 'right' }}>수량</span>
        <span style={{ textAlign: 'right' }}>합계</span>
      </div>

      {/*
        Layout: asks (top half) / mid bar (fixed) / bids (bottom half).
        Each side gets `flex: 1` so they split available height 50/50 — mid
        bar stays at the visual center regardless of how many levels are
        loaded. Asks anchor to the bottom (`justifyContent: flex-end`) so
        the best ask sits right above the mid bar; bids anchor to the top
        (default) so the best bid sits right below.

        Outer container is `overflow: hidden` as a safety net for tiny
        viewports, but the parent grid (TradePage desktop) gives this
        panel both rows of the layout — ~800px+ vertical real estate —
        so 15 + 15 levels at 24px row height + chrome (~80px) all fit
        without clipping in normal use. No scrollbars, no clipping.
      */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
          }}
        >
          {asks.map((r, i) => {
            const pct = totalAskQty > 0 ? (Number(r.quantity) / totalAskQty) * 100 : 0;
            return <Row key={'a' + i} side="ask" r={r} pct={pct} />;
          })}
        </div>
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 12px',
            borderTop: `1px solid ${T.borderSoft}`,
            borderBottom: `1px solid ${T.borderSoft}`,
            background: T.bgAlt,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-num)',
              fontVariantNumeric: 'tabular-nums',
              fontSize: 15,
              fontWeight: 700,
              color: T.up,
            }}
          >
            {mid != null ? fmtNum(mid, dig) : '—'}
          </span>
          <span style={{ fontSize: 10.5, color: T.text3 }}>
            {mid != null ? `≈ ${quoteAsset === 'KRW' ? '₩' : ''}${fmtNum(mid, 0)}` : ''}
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {bids.map((r, i) => {
            const pct = totalBidQty > 0 ? (Number(r.quantity) / totalBidQty) * 100 : 0;
            return <Row key={'b' + i} side="bid" r={r} pct={pct} />;
          })}
        </div>
      </div>
    </div>
  );
}
