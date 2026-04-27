import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader, Card } from '../components/PageHeader';
import { profile } from '../lib/keycloak';

interface Stats {
  userCount: number;
  marketCount: number;
  enabledMarketCount: number;
  openOrderCount: number;
  trades24h: number;
  volume24hKrw: string | null;
}

export function DashboardPage() {
  const me = profile();
  const { data, isError, error } = useQuery<Stats>({
    queryKey: ['admin-stats'],
    queryFn: async () => (await api.get<Stats>('/stats')).data,
    refetchInterval: 5000,
  });

  return (
    <>
      <PageHeader
        title="대시보드"
        subtitle={
          <>
            안녕하세요, <strong>{me.email ?? me.username}</strong> · 권한:{' '}
            {me.realmRoles.join(', ') || '(없음)'}
          </>
        }
      />
      {isError && (
        <Card>
          <div style={{ color: 'var(--danger)' }}>
            stats 로드 실패: {(error as Error).message}
          </div>
        </Card>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        <StatCard label="사용자" value={data?.userCount} />
        <StatCard
          label="활성 마켓"
          value={data ? `${data.enabledMarketCount} / ${data.marketCount}` : undefined}
        />
        <StatCard label="미체결 주문" value={data?.openOrderCount} />
        <StatCard label="24h 체결 건수" value={data?.trades24h} />
        <StatCard
          label="24h 거래대금 (KRW 환산)"
          value={data?.volume24hKrw ? `₩ ${formatNum(data.volume24hKrw)}` : undefined}
        />
      </div>
    </>
  );
}

function StatCard({ label, value }: { label: string; value: number | string | undefined }) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border-soft)',
        borderRadius: 'var(--radius)',
        padding: 16,
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600 }}>{label}</div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>
        {value ?? '—'}
      </div>
    </div>
  );
}

function formatNum(s: string | number): string {
  const n = typeof s === 'number' ? s : Number(s);
  return n.toLocaleString();
}
