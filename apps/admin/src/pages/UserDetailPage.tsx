import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { PageHeader, Card } from '../components/PageHeader';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { hasRole } from '../lib/keycloak';

interface UserDetail {
  id: string;
  email: string;
  frozen: boolean;
  createdAt: string;
  wallets: { asset: string; balance: string; locked: string }[];
  orders: {
    id: string; market: string; side: string; type: string; price: string | null;
    quantity: string; leaveQty: string; filledQty: string; status: string; createdAt: string;
  }[];
  trades: {
    id: string; market: string; price: string; quantity: string; side: string;
    role: string; fee: string; createdAt: string;
  }[];
}

export function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<UserDetail>({
    queryKey: ['admin-user', id],
    queryFn: async () => (await api.get<UserDetail>(`/users/${id}`)).data,
    enabled: !!id,
  });

  const [freezeOpen, setFreezeOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState<{ asset: string; field: 'balance' | 'locked' } | null>(null);
  const [delta, setDelta] = useState('');

  const freezeMut = useMutation({
    mutationFn: async (vars: { frozen: boolean; reason: string }) =>
      api.patch(`/users/${id}/freeze`, vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-user', id] });
      setFreezeOpen(false);
    },
  });

  const adjustMut = useMutation({
    mutationFn: async (vars: { asset: string; field: 'balance' | 'locked'; delta: string; reason: string }) =>
      api.post(`/users/${id}/wallets/${vars.asset}/adjust`, {
        delta: vars.delta,
        field: vars.field,
        reason: vars.reason,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-user', id] });
      setAdjustOpen(null);
      setDelta('');
    },
  });

  if (isLoading) return <div style={{ padding: 24 }}>로딩…</div>;
  if (error) return <div style={{ padding: 24, color: 'var(--danger)' }}>{(error as Error).message}</div>;
  if (!data) return null;

  const canFreeze = hasRole('WALLET_ADJUST');
  const canAdjust = hasRole('WALLET_ADJUST');

  return (
    <>
      <PageHeader
        title={data.email}
        subtitle={
          <>
            <code className="mono" style={{ fontSize: 11 }}>{data.id}</code>
            {' · '}가입 {new Date(data.createdAt).toLocaleString()}
          </>
        }
        right={
          canFreeze && (
            <button
              onClick={() => setFreezeOpen(true)}
              style={{
                padding: '6px 12px',
                border: `1px solid ${data.frozen ? 'var(--ok)' : 'var(--danger)'}`,
                color: data.frozen ? 'var(--ok)' : 'var(--danger)',
                background: 'transparent',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {data.frozen ? '계정 해제' : '계정 동결'}
            </button>
          )
        }
      />

      <Card>
        <h3 style={{ margin: 0, fontSize: 13 }}>지갑</h3>
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>자산</th>
              <th style={{ textAlign: 'right' }}>balance</th>
              <th style={{ textAlign: 'right' }}>locked</th>
              {canAdjust && <th style={{ width: 200 }}>조정</th>}
            </tr>
          </thead>
          <tbody>
            {data.wallets.map((w) => (
              <tr key={w.asset}>
                <td><strong>{w.asset}</strong></td>
                <td className="mono" style={{ textAlign: 'right' }}>{Number(w.balance).toLocaleString()}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{Number(w.locked).toLocaleString()}</td>
                {canAdjust && (
                  <td>
                    <button onClick={() => setAdjustOpen({ asset: w.asset, field: 'balance' })}
                      style={btnSmall}>balance ±</button>
                    {' '}
                    <button onClick={() => setAdjustOpen({ asset: w.asset, field: 'locked' })}
                      style={btnSmall}>locked ±</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <h3 style={{ margin: 0, fontSize: 13 }}>최근 주문 (20)</h3>
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>ID</th>
              <th>마켓</th>
              <th>방향</th>
              <th>타입</th>
              <th style={{ textAlign: 'right' }}>가격</th>
              <th style={{ textAlign: 'right' }}>수량</th>
              <th style={{ textAlign: 'right' }}>잔량</th>
              <th>상태</th>
              <th>시각</th>
            </tr>
          </thead>
          <tbody>
            {data.orders.map((o) => (
              <tr key={o.id}>
                <td className="mono" style={{ fontSize: 11 }}>{o.id}</td>
                <td>{o.market}</td>
                <td><SideBadge side={o.side} /></td>
                <td>{o.type}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{o.price ?? '—'}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{o.quantity}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{o.leaveQty}</td>
                <td><StatusBadge status={o.status} /></td>
                <td style={{ fontSize: 11 }}>{new Date(o.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <h3 style={{ margin: 0, fontSize: 13 }}>최근 체결 (20)</h3>
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>ID</th>
              <th>마켓</th>
              <th>방향</th>
              <th>역할</th>
              <th style={{ textAlign: 'right' }}>가격</th>
              <th style={{ textAlign: 'right' }}>수량</th>
              <th style={{ textAlign: 'right' }}>수수료</th>
              <th>시각</th>
            </tr>
          </thead>
          <tbody>
            {data.trades.map((t) => (
              <tr key={t.id}>
                <td className="mono" style={{ fontSize: 11 }}>{t.id}</td>
                <td>{t.market}</td>
                <td><SideBadge side={t.side} /></td>
                <td>{t.role}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{t.price}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{t.quantity}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{t.fee}</td>
                <td style={{ fontSize: 11 }}>{new Date(t.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <ConfirmDialog
        open={freezeOpen}
        title={data.frozen ? '계정 동결 해제' : '계정 동결'}
        body={
          <>
            <p>{data.email}{data.frozen ? ' 의 동결을 해제합니다.' : ' 의 신규 주문을 모두 차단합니다.'}</p>
            <p style={{ color: 'var(--text-3)', fontSize: 12 }}>
              기존 OPEN/PARTIAL 주문은 자동 취소되지 않습니다 — 별도 강제 취소 필요.
            </p>
          </>
        }
        challengeText={data.email}
        challengeLabel="확인을 위해 사용자 이메일 입력"
        confirmLabel={data.frozen ? '동결 해제' : '동결 적용'}
        loading={freezeMut.isPending}
        onCancel={() => setFreezeOpen(false)}
        onConfirm={(reason) => freezeMut.mutate({ frozen: !data.frozen, reason })}
      />

      {adjustOpen && (
        <ConfirmDialog
          open
          title={`잔고 조정 — ${adjustOpen.asset} ${adjustOpen.field}`}
          body={
            <>
              <p>
                {data.email} ({data.id.slice(-8)}) 의 <strong>{adjustOpen.asset}</strong>{' '}
                <strong>{adjustOpen.field}</strong> 를 변경합니다.
              </p>
              <input
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                placeholder='delta (e.g. "100" or "-0.5")'
                style={{
                  marginTop: 8,
                  width: '100%',
                  padding: '6px 8px',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontFamily: 'var(--font-num)',
                }}
              />
            </>
          }
          challengeText={data.id.slice(-8)}
          challengeLabel="확인을 위해 user id 끝 8자리 입력"
          confirmLabel="조정 적용"
          loading={adjustMut.isPending}
          onCancel={() => { setAdjustOpen(null); setDelta(''); }}
          onConfirm={(reason) =>
            adjustMut.mutate({
              asset: adjustOpen.asset,
              field: adjustOpen.field,
              delta,
              reason,
            })
          }
        />
      )}
    </>
  );
}

const btnSmall: React.CSSProperties = {
  padding: '2px 6px',
  fontSize: 10.5,
  border: '1px solid var(--border)',
  borderRadius: 3,
  background: 'transparent',
};

function SideBadge({ side }: { side: string }) {
  const isBid = side === 'BID';
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
      background: isBid ? 'var(--up-bg)' : 'var(--down-bg)',
      color: isBid ? 'var(--up)' : 'var(--down)',
    }}>{side}</span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    OPEN: 'var(--brand-ink)',
    PARTIAL: 'var(--warn)',
    FILLED: 'var(--ok)',
    CANCELLED: 'var(--text-3)',
    REJECTED: 'var(--danger)',
  };
  return (
    <span style={{ color: colorMap[status] ?? 'var(--text-2)', fontSize: 11, fontWeight: 600 }}>
      {status}
    </span>
  );
}
