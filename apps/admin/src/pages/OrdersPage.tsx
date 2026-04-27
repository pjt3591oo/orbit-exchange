import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader, Card } from '../components/PageHeader';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Pagination, useCursorPagination } from '../components/Pagination';
import { hasRole } from '../lib/keycloak';

interface OrderRow {
  id: string; userId: string; market: string; side: string; type: string;
  price: string | null; quantity: string; leaveQty: string; filledQty: string;
  status: string; createdAt: string;
}

export function OrdersPage() {
  const [filter, setFilter] = useState({ userId: '', market: '', status: 'OPEN,PARTIAL' });
  const qc = useQueryClient();
  const { currentCursor, page, pushNext, popPrev, hasPrev } = useCursorPagination([
    filter.userId,
    filter.market,
    filter.status,
  ]);
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin-orders', filter, currentCursor],
    queryFn: async () =>
      (await api.get<{ items: OrderRow[]; nextCursor: string | null }>('/orders', {
        params: {
          ...(filter.userId && { userId: filter.userId }),
          ...(filter.market && { market: filter.market }),
          ...(filter.status && { status: filter.status }),
          ...(currentCursor && { cursor: currentCursor }),
        },
      })).data,
  });

  const [cancelTarget, setCancelTarget] = useState<OrderRow | null>(null);
  const cancelMut = useMutation({
    mutationFn: async (vars: { id: string; reason: string }) =>
      api.post(`/orders/${vars.id}/cancel`, { reason: vars.reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-orders'] });
      setCancelTarget(null);
    },
  });

  const canCancel = hasRole('MARKET_OPS');

  return (
    <>
      <PageHeader
        title="주문"
        subtitle="user / market / status / 시간 으로 검색"
      />
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <FilterInput
            label="user id"
            value={filter.userId}
            onChange={(v) => setFilter({ ...filter, userId: v })}
          />
          <FilterInput
            label="market (e.g. BTC-KRW)"
            value={filter.market}
            onChange={(v) => setFilter({ ...filter, market: v })}
          />
          <FilterInput
            label="status (comma list)"
            value={filter.status}
            onChange={(v) => setFilter({ ...filter, status: v })}
          />
        </div>
      </Card>

      <Card padded={false}>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>User</th>
              <th>마켓</th>
              <th>방향</th>
              <th>타입</th>
              <th style={{ textAlign: 'right' }}>가격</th>
              <th style={{ textAlign: 'right' }}>수량</th>
              <th style={{ textAlign: 'right' }}>잔량</th>
              <th>상태</th>
              <th>시각</th>
              {canCancel && <th></th>}
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={11} style={{ padding: 12, color: 'var(--text-3)' }}>로딩…</td></tr>}
            {data?.items.map((o) => (
              <tr key={o.id}>
                <td className="mono" style={{ fontSize: 11 }}>{o.id}</td>
                <td className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{o.userId.slice(-8)}</td>
                <td>{o.market}</td>
                <td>
                  <span style={{
                    fontSize: 10.5, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                    background: o.side === 'BID' ? 'var(--up-bg)' : 'var(--down-bg)',
                    color: o.side === 'BID' ? 'var(--up)' : 'var(--down)',
                  }}>{o.side}</span>
                </td>
                <td>{o.type}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{o.price ?? '—'}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{o.quantity}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{o.leaveQty}</td>
                <td><StatusBadge status={o.status} /></td>
                <td style={{ fontSize: 11 }}>{new Date(o.createdAt).toLocaleString()}</td>
                {canCancel && (
                  <td>
                    {(o.status === 'OPEN' || o.status === 'PARTIAL') && (
                      <button
                        onClick={() => setCancelTarget(o)}
                        style={{
                          padding: '2px 8px', fontSize: 10.5, border: '1px solid var(--danger)',
                          color: 'var(--danger)', borderRadius: 3, background: 'transparent',
                        }}
                      >
                        강제 취소
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination
          page={page}
          hasPrev={hasPrev}
          hasNext={!!data?.nextCursor}
          onPrev={popPrev}
          onNext={() => pushNext(data?.nextCursor)}
          loading={isFetching}
          itemsCount={data?.items.length}
        />
      </Card>

      {cancelTarget && (
        <ConfirmDialog
          open
          title="주문 강제 취소"
          body={
            <>
              <p>주문 <code className="mono">{cancelTarget.id}</code> 를 강제 취소합니다.</p>
              <p style={{ color: 'var(--text-3)', fontSize: 12 }}>
                Kafka CANCEL 명령이 발행되며, 매처가 비동기로 처리합니다 (잔고 환불 포함).
              </p>
            </>
          }
          challengeText={cancelTarget.id}
          challengeLabel="확인을 위해 주문 ID 입력"
          confirmLabel="강제 취소"
          loading={cancelMut.isPending}
          onCancel={() => setCancelTarget(null)}
          onConfirm={(reason) => cancelMut.mutate({ id: cancelTarget.id, reason })}
        />
      )}
    </>
  );
}

function FilterInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%', padding: '6px 8px', border: '1px solid var(--border)',
          borderRadius: 4, fontSize: 12,
        }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    OPEN: 'var(--brand-ink)', PARTIAL: 'var(--warn)', FILLED: 'var(--ok)',
    CANCELLED: 'var(--text-3)', REJECTED: 'var(--danger)',
  };
  return <span style={{ color: colorMap[status] ?? 'var(--text-2)', fontSize: 11, fontWeight: 600 }}>{status}</span>;
}
