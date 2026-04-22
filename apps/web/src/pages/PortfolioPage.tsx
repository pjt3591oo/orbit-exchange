import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuthStore } from '../store/auth';
import { T, fmtKRW, fmtNum, fmtPct } from '../design/tokens';
import { Tag } from '../design/atoms';

interface WalletRow { asset: string; balance: string; locked: string; }
interface MarketRow { symbol: string; baseAsset: string; quoteAsset: string; }
interface TradeRow { price: string; }

export function PortfolioPage() {
  const token = useAuthStore((s) => s.accessToken);

  const { data: wallets } = useQuery({
    queryKey: ['wallets'],
    queryFn: async () => (await api.get<WalletRow[]>('/wallets')).data,
    enabled: !!token,
    refetchInterval: 3000,
  });
  const { data: markets } = useQuery({
    queryKey: ['markets'],
    queryFn: async () => (await api.get<MarketRow[]>('/markets')).data,
  });

  // Per-asset last trade price against KRW (for valuation).
  const krwMarkets = (markets ?? []).filter((m) => m.quoteAsset === 'KRW');
  const { data: priceMap } = useQuery({
    queryKey: ['portfolio-prices', krwMarkets.map((m) => m.symbol).join(',')],
    enabled: krwMarkets.length > 0,
    refetchInterval: 5000,
    queryFn: async () => {
      const entries = await Promise.all(
        krwMarkets.map(async (m) => {
          const { data } = await api.get<TradeRow[]>(`/markets/${m.symbol}/trades`, {
            params: { limit: 1 },
          });
          return [m.baseAsset, data[0] ? Number(data[0].price) : null] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, number | null>;
    },
  });

  const rows = (wallets ?? []).map((w) => {
    const total = Number(w.balance) + Number(w.locked);
    const isKRW = w.asset === 'KRW';
    const unitPrice = isKRW ? 1 : priceMap?.[w.asset] ?? null;
    const krwValue = unitPrice != null ? total * unitPrice : null;
    return { ...w, total, unitPrice, krwValue };
  });
  const totalKrw = rows.reduce((a, r) => a + (r.krwValue ?? 0), 0);
  const cashKrw = rows.find((r) => r.asset === 'KRW')?.total ?? 0;
  const cryptoKrw = totalKrw - cashKrw;
  const cryptoRatio = totalKrw > 0 ? (cryptoKrw / totalKrw) * 100 : 0;

  if (!token) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: T.text3 }}>
        포트폴리오를 보려면 로그인이 필요합니다.
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1040, margin: '0 auto' }}>
      {/* Summary */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 12,
          marginBottom: 14,
        }}
      >
        <SummaryCard
          label="총 자산"
          value={fmtKRW(totalKrw)}
          caption="KRW 환산"
        />
        <SummaryCard label="현금 (KRW)" value={fmtKRW(cashKrw)} />
        <SummaryCard
          label="코인 비중"
          value={fmtPct(cryptoRatio, 1)}
          caption={`${fmtKRW(cryptoKrw)} 상당`}
        />
      </div>

      {/* Holdings */}
      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: `1px solid ${T.borderSoft}`,
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700 }}>보유 자산</span>
          <span style={{ fontSize: 11, color: T.text3 }}>실시간 · 5초 주기</span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['자산', '보유수량', '잠금', '현재가', '평가금액', '비중'].map((h, i) => (
                <th
                  key={h}
                  style={{
                    textAlign: i === 0 ? 'left' : 'right',
                    fontSize: 11,
                    color: T.text3,
                    fontWeight: 600,
                    padding: '10px 14px',
                    background: T.bgAlt,
                    borderBottom: `1px solid ${T.borderSoft}`,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ratio = totalKrw > 0 ? ((r.krwValue ?? 0) / totalKrw) * 100 : 0;
              const isKRW = r.asset === 'KRW';
              return (
                <tr key={r.asset}>
                  <td
                    style={{
                      padding: '12px 14px',
                      borderBottom: `1px solid ${T.borderSoft}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          background: T.brandSoft,
                          color: T.brandInk,
                          fontSize: 10.5,
                          fontWeight: 800,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {r.asset}
                      </div>
                      <span style={{ fontWeight: 600 }}>{r.asset}</span>
                      {isKRW && <Tag tone="brand">원화</Tag>}
                    </div>
                  </td>
                  <td className="mono" style={td()}>
                    {isKRW ? fmtNum(r.balance, 0) : Number(r.balance).toFixed(8)}
                  </td>
                  <td className="mono" style={{ ...td(), color: T.text3 }}>
                    {isKRW ? fmtNum(r.locked, 0) : Number(r.locked).toFixed(8)}
                  </td>
                  <td className="mono" style={td()}>
                    {isKRW ? '—' : r.unitPrice != null ? fmtNum(r.unitPrice, 0) : '—'}
                  </td>
                  <td className="mono" style={{ ...td(), fontWeight: 700 }}>
                    {r.krwValue != null ? fmtKRW(r.krwValue) : '—'}
                  </td>
                  <td className="mono" style={td()}>
                    {fmtPct(ratio, 1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        padding: '14px 18px',
      }}
    >
      <div style={{ fontSize: 11, color: T.text3, fontWeight: 600 }}>{label}</div>
      <div
        className="mono"
        style={{ fontSize: 22, fontWeight: 700, color: T.text, marginTop: 4 }}
      >
        {value}
      </div>
      {caption && (
        <div
          className="mono"
          style={{ fontSize: 11, color: T.text3, marginTop: 4 }}
        >
          {caption}
        </div>
      )}
    </div>
  );
}

function td(): React.CSSProperties {
  return {
    padding: '12px 14px',
    textAlign: 'right',
    borderBottom: `1px solid ${T.borderSoft}`,
  };
}
