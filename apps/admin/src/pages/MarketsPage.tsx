import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { PageHeader, Card } from '../components/PageHeader';

interface MarketRow {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: string;
  stepSize: string;
  minNotional: string;
  takerFeeBp: number;
  makerFeeBp: number;
  enabled: boolean;
  openOrderCount: number;
  trades24h: number;
}

export function MarketsPage() {
  const { data, isLoading } = useQuery<MarketRow[]>({
    queryKey: ['admin-markets'],
    queryFn: async () => (await api.get<MarketRow[]>('/markets')).data,
  });

  return (
    <>
      <PageHeader title="마켓" subtitle="거래 가능한 마켓 목록" />
      <Card padded={false}>
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Base / Quote</th>
              <th style={{ textAlign: 'right' }}>Tick</th>
              <th style={{ textAlign: 'right' }}>Step</th>
              <th style={{ textAlign: 'right' }}>Min Notional</th>
              <th style={{ textAlign: 'right' }}>Maker / Taker (bp)</th>
              <th style={{ textAlign: 'right' }}>미체결</th>
              <th style={{ textAlign: 'right' }}>24h 체결</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={9} style={{ padding: 12, color: 'var(--text-3)' }}>로딩…</td></tr>}
            {data?.map((m) => (
              <tr key={m.symbol}>
                <td>
                  <Link to={`/markets/${m.symbol}`} style={{ color: 'var(--brand-ink)', fontWeight: 600 }}>
                    {m.symbol}
                  </Link>
                </td>
                <td>{m.baseAsset} / {m.quoteAsset}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{m.tickSize}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{m.stepSize}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{m.minNotional}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{m.makerFeeBp} / {m.takerFeeBp}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{m.openOrderCount}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{m.trades24h}</td>
                <td>
                  {m.enabled
                    ? <span style={{ color: 'var(--ok)', fontSize: 11, fontWeight: 600 }}>enabled</span>
                    : <span style={{ color: 'var(--danger)', fontSize: 11, fontWeight: 600 }}>disabled</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
