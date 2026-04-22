import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { getMarketSocket } from '../../lib/ws';
import { T, fmtNum, priceDigits } from '../../design/tokens';

interface Trade {
  id: string;
  price: string;
  quantity: string;
  takerSide: 'BID' | 'ASK';
  ts: number;
}

export function TradesPanel({ symbol }: { symbol: string }) {
  const [trades, setTrades] = useState<Trade[]>([]);

  useQuery({
    queryKey: ['tape', symbol],
    queryFn: async () => {
      const { data } = await api.get<Trade[]>(`/markets/${symbol}/trades`, {
        params: { limit: 50 },
      });
      setTrades(data);
      return data;
    },
  });

  useEffect(() => {
    const sock = getMarketSocket();
    sock.emit('subscribe', { symbol });
    const handler = (t: any) => {
      if (t.market !== symbol) return;
      setTrades((prev) =>
        [{ id: String(t.id), price: t.price, quantity: t.quantity, takerSide: t.takerSide, ts: t.ts }, ...prev].slice(0, 50),
      );
    };
    sock.on('trade', handler);
    return () => {
      sock.off('trade', handler);
    };
  }, [symbol]);

  const dig = trades[0] ? priceDigits(Number(trades[0].price)) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.card }}>
      <div
        style={{
          padding: '8px 12px',
          borderBottom: `1px solid ${T.borderSoft}`,
          fontSize: 12,
          fontWeight: 700,
          color: T.text,
        }}
      >
        체결
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 68px',
          padding: '6px 12px',
          fontSize: 10,
          color: T.text3,
          fontWeight: 600,
          borderBottom: `1px solid ${T.borderSoft}`,
        }}
      >
        <span>가격</span>
        <span style={{ textAlign: 'right' }}>수량</span>
        <span style={{ textAlign: 'right' }}>시간</span>
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>
        {trades.map((t) => {
          const col = t.takerSide === 'BID' ? T.up : T.down;
          const d = new Date(t.ts);
          const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
          return (
            <div
              key={t.id}
              className="mono"
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 68px',
                padding: '4px 12px',
                fontSize: 11.5,
              }}
            >
              <span style={{ color: col, fontWeight: 600 }}>{fmtNum(t.price, dig)}</span>
              <span style={{ color: T.text, textAlign: 'right' }}>
                {Number(t.quantity).toFixed(4)}
              </span>
              <span style={{ color: T.text3, textAlign: 'right' }}>{time}</span>
            </div>
          );
        })}
        {trades.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: T.text3, fontSize: 12 }}>
            체결 내역이 없습니다
          </div>
        )}
      </div>
    </div>
  );
}
