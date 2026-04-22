import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { T, fmtPct } from '../design/tokens';

interface MarketRow {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  takerFeeBp: number;
  makerFeeBp: number;
}

/** Lightweight landing page that redirects users into the trading view. */
export function MarketsPage() {
  const nav = useNavigate();
  const { data } = useQuery({
    queryKey: ['markets'],
    queryFn: async () => (await api.get<MarketRow[]>('/markets')).data,
  });

  return (
    <div
      style={{
        maxWidth: 960,
        margin: '40px auto',
        padding: 24,
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 12,
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>
        마켓
      </div>
      <div style={{ fontSize: 12, color: T.text3, marginBottom: 20 }}>
        거래할 종목을 선택하세요.
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['마켓', '기본자산', '결제자산', 'Maker/Taker', ''].map((h) => (
              <th
                key={h}
                style={{
                  textAlign: 'left',
                  fontSize: 11,
                  fontWeight: 600,
                  color: T.text3,
                  padding: '10px 12px',
                  borderBottom: `1px solid ${T.borderSoft}`,
                  letterSpacing: 0.2,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data?.map((m) => (
            <tr
              key={m.symbol}
              onClick={() => nav(`/trade/${m.symbol}`)}
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = T.hover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <td
                style={{
                  padding: '12px',
                  borderBottom: `1px solid ${T.borderSoft}`,
                  fontWeight: 700,
                  color: T.text,
                }}
              >
                {m.symbol}
              </td>
              <td
                style={{
                  padding: '12px',
                  borderBottom: `1px solid ${T.borderSoft}`,
                  color: T.text2,
                }}
              >
                {m.baseAsset}
              </td>
              <td
                style={{
                  padding: '12px',
                  borderBottom: `1px solid ${T.borderSoft}`,
                  color: T.text2,
                }}
              >
                {m.quoteAsset}
              </td>
              <td
                className="mono"
                style={{
                  padding: '12px',
                  borderBottom: `1px solid ${T.borderSoft}`,
                  color: T.text2,
                }}
              >
                {(m.makerFeeBp / 100).toFixed(2)}% / {(m.takerFeeBp / 100).toFixed(2)}%
              </td>
              <td
                style={{
                  padding: '12px',
                  borderBottom: `1px solid ${T.borderSoft}`,
                  textAlign: 'right',
                  color: T.brandInk,
                  fontWeight: 600,
                }}
              >
                거래 →
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
