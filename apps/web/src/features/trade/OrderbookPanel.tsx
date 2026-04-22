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

  // asks: descending (high→low) so top row is the highest ask, bottom row (just above mid) is the best (lowest) ask.
  // bids: descending too — the best (highest) bid sits right below mid.
  const asks = useMemo(
    () => [...snap.asks].sort((a, b) => Number(b.price) - Number(a.price)),
    [snap.asks],
  );
  const bids = useMemo(
    () => [...snap.bids].sort((a, b) => Number(b.price) - Number(a.price)),
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

  const maxQty = useMemo(() => {
    const all = [...snap.asks, ...snap.bids].map((l) => Number(l.quantity));
    return Math.max(0.0001, ...all);
  }, [snap]);

  const dig = mid ? priceDigits(mid) : 0;

  const Row = ({ side, r }: { side: 'ask' | 'bid'; r: Level }) => {
    const isAsk = side === 'ask';
    const col = isAsk ? T.down : T.up; // Korean orderbook: ask=blue, bid=red
    const bg = isAsk ? T.downBg : T.upBg;
    const pct = (Number(r.quantity) / maxQty) * 100;
    const sum = Number(r.price) * Number(r.quantity);
    return (
      <div
        onClick={() => onPickPrice(r.price)}
        style={{
          position: 'relative',
          height: 22,
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
            padding: '0 10px',
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
          padding: '6px 10px',
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

      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div>{asks.map((r, i) => <Row key={'a' + i} side="ask" r={r} />)}</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 10px',
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
        <div>{bids.map((r, i) => <Row key={'b' + i} side="bid" r={r} />)}</div>
      </div>
    </div>
  );
}
