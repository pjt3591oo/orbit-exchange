import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { hasAnyRole } from '../lib/keycloak';
import { PageHeader, Card } from '../components/PageHeader';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface OutboxRow {
  id: string;
  topic: string;
  key: string;
  createdAt: string;
  processedAt: string | null;
  attempts: number;
  lastError: string | null;
  ageSec: number;
}

interface OutboxDetail extends OutboxRow {
  payload: unknown;
  headers: unknown;
}

interface OutboxStats {
  pendingTotal: number;
  pendingFailed: number;
  oldestPendingAgeSec: number;
  processedLast24h: number;
  perTopic: Array<{ topic: string; pending: number; oldestAgeSec: number }>;
}

type Status = 'pending' | 'processed' | 'failed' | 'all';

/**
 * /outbox — operator surface for the OutboxEvent table (ADR-0002).
 *
 * Top: stats cards (pending count, failed count, oldest age, 24h
 * throughput) + per-topic backlog table.
 *
 * Bottom: filterable list with payload inspection + retry / skip
 * actions (MARKET_OPS only). Skip is heavily guarded (red dialog +
 * type-the-id confirmation + reason).
 */
export function OutboxPage() {
  const canMutate = hasAnyRole(['MARKET_OPS']);
  const [status, setStatus] = useState<Status>('pending');
  const [topic, setTopic] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: 'retry'; row: OutboxRow }
    | { kind: 'skip'; row: OutboxRow }
    | null
  >(null);

  const qc = useQueryClient();
  const stats = useQuery({
    queryKey: ['admin-outbox-stats'],
    queryFn: async () => (await api.get<OutboxStats>('/outbox/stats')).data,
    refetchInterval: 5_000,
  });
  const list = useQuery({
    queryKey: ['admin-outbox', status, topic],
    queryFn: async () =>
      (await api.get<{ items: OutboxRow[]; nextCursor: string | null }>(
        '/outbox',
        { params: { status, ...(topic && { topic }) } },
      )).data,
  });
  const detail = useQuery({
    queryKey: ['admin-outbox-detail', expanded],
    queryFn: async () =>
      expanded
        ? (await api.get<OutboxDetail>(`/outbox/${expanded}`)).data
        : null,
    enabled: !!expanded,
  });

  const retryMut = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      (await api.post(`/outbox/${id}/retry`, { reason })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-outbox'] });
      void qc.invalidateQueries({ queryKey: ['admin-outbox-stats'] });
      setConfirm(null);
    },
  });
  const skipMut = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      (await api.post(`/outbox/${id}/skip`, { reason })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-outbox'] });
      void qc.invalidateQueries({ queryKey: ['admin-outbox-stats'] });
      setConfirm(null);
    },
  });

  return (
    <>
      <PageHeader
        title="Outbox"
        subtitle="ADR-0002 outbox 상태 검사 + 정체된 행 retry / skip"
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
        <StatCard
          label="미처리 (pending)"
          value={stats.data?.pendingTotal ?? '—'}
          tone={
            (stats.data?.pendingTotal ?? 0) > 100
              ? 'danger'
              : (stats.data?.pendingTotal ?? 0) > 10
              ? 'warn'
              : 'ok'
          }
        />
        <StatCard
          label="실패 (attempts > 0)"
          value={stats.data?.pendingFailed ?? '—'}
          tone={(stats.data?.pendingFailed ?? 0) > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="가장 오래된 미처리 (sec)"
          value={
            typeof stats.data?.oldestPendingAgeSec === 'number'
              ? Math.round(stats.data.oldestPendingAgeSec)
              : '—'
          }
          tone={
            (stats.data?.oldestPendingAgeSec ?? 0) > 300
              ? 'danger'
              : (stats.data?.oldestPendingAgeSec ?? 0) > 30
              ? 'warn'
              : 'ok'
          }
        />
        <StatCard
          label="최근 24h 처리됨"
          value={stats.data?.processedLast24h ?? '—'}
          tone="muted"
        />
      </div>

      {stats.data && stats.data.perTopic.length > 0 && (
        <Card padded={false}>
          <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>
            토픽별 백로그
          </div>
          <table>
            <thead>
              <tr>
                <th>토픽</th>
                <th>미처리</th>
                <th>가장 오래된 (sec)</th>
              </tr>
            </thead>
            <tbody>
              {stats.data.perTopic.map((t) => (
                <tr key={t.topic}>
                  <td className="mono" style={{ fontSize: 12 }}>{t.topic}</td>
                  <td className="mono">{t.pending}</td>
                  <td className="mono">{Math.round(t.oldestAgeSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr) auto', gap: 12, alignItems: 'end' }}>
          <div>
            <div style={labelStyle}>상태</div>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Status)}
              style={inputStyle}
            >
              <option value="pending">미처리</option>
              <option value="failed">실패 (attempts &gt; 0)</option>
              <option value="processed">처리됨 (최신순)</option>
              <option value="all">전체</option>
            </select>
          </div>
          <In label="topic (예: orbit.trades.v1)" v={topic} on={setTopic} />
          <div />
          <button
            onClick={() => list.refetch()}
            style={{
              padding: '6px 12px',
              border: '1px solid var(--border)',
              borderRadius: 4,
              background: 'transparent',
              fontSize: 12,
            }}
          >
            새로고침
          </button>
        </div>
      </Card>

      <Card padded={false}>
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>토픽</th>
              <th>key</th>
              <th>나이</th>
              <th>attempts</th>
              <th>lastError</th>
              <th>processedAt</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr><td colSpan={8} style={{ padding: 12, color: 'var(--text-3)' }}>로딩…</td></tr>
            )}
            {list.data?.items.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: 16, color: 'var(--text-3)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>비어있음 ✓</div>
                  <div style={{ fontSize: 11, lineHeight: 1.6 }}>
                    {status === 'pending' && '모든 outbox 행이 처리됐습니다 (relay 가 따라잡고 있음).'}
                    {status === 'failed' && 'attempts &gt; 0 인 미처리 행이 없습니다.'}
                    {status === 'processed' && '최근 처리된 행이 없습니다.'}
                  </div>
                </td>
              </tr>
            )}
            {list.data?.items.map((r) => {
              const stuck = !r.processedAt && r.attempts > 0;
              return (
                <>
                  <tr key={r.id} style={stuck ? { background: 'var(--bg-alt)' } : undefined}>
                    <td className="mono" style={{ fontSize: 11 }}>{r.id}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{r.topic}</td>
                    <td className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      {r.key.length > 24 ? r.key.slice(0, 24) + '…' : r.key}
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: r.ageSec > 60 ? 'var(--danger)' : undefined }}>
                      {formatAge(r.ageSec)}
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: r.attempts > 0 ? 'var(--danger)' : undefined }}>
                      {r.attempts}
                    </td>
                    <td style={{ fontSize: 11, maxWidth: 260, color: 'var(--danger)' }} title={r.lastError ?? ''}>
                      {r.lastError ? (r.lastError.length > 50 ? r.lastError.slice(0, 50) + '…' : r.lastError) : '—'}
                    </td>
                    <td style={{ fontSize: 11, color: r.processedAt ? 'var(--ok)' : 'var(--text-3)' }}>
                      {r.processedAt ? new Date(r.processedAt).toLocaleTimeString() : 'pending'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                          style={btnSecondary}
                        >
                          {expanded === r.id ? '접기' : '상세'}
                        </button>
                        {canMutate && !r.processedAt && r.attempts > 0 && (
                          <button onClick={() => setConfirm({ kind: 'retry', row: r })} style={btnPrimary}>
                            retry
                          </button>
                        )}
                        {canMutate && !r.processedAt && (
                          <button onClick={() => setConfirm({ kind: 'skip', row: r })} style={btnDanger}>
                            skip
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr key={`${r.id}-d`}>
                      <td colSpan={8} style={{ background: 'var(--bg-alt)', padding: 12 }}>
                        {detail.isLoading || !detail.data ? (
                          <div style={{ color: 'var(--text-3)' }}>로딩…</div>
                        ) : (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                            <div>
                              <div style={labelStyle}>payload</div>
                              <pre style={preStyle}>{JSON.stringify(detail.data.payload, null, 2)}</pre>
                            </div>
                            <div>
                              <div style={labelStyle}>headers</div>
                              <pre style={preStyle}>{JSON.stringify(detail.data.headers, null, 2)}</pre>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </Card>

      {confirm && confirm.kind === 'retry' && (
        <ConfirmDialog
          open
          title={`Outbox retry — ${confirm.row.topic}`}
          body={
            <>
              <div className="mono" style={{ fontSize: 12 }}>
                id={confirm.row.id} attempts={confirm.row.attempts}
              </div>
              <p style={{ marginTop: 8, fontSize: 12 }}>
                <code>attempts</code> 와 <code>lastError</code> 를 초기화합니다.
                relay 가 다음 polling tick (~100ms) 에 다시 발행을 시도합니다.
                같은 에러가 또 나면 새 attempts 카운트가 다시 올라갑니다.
              </p>
            </>
          }
          confirmLabel="retry 실행"
          loading={retryMut.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => retryMut.mutate({ id: confirm.row.id, reason })}
        />
      )}

      {confirm && confirm.kind === 'skip' && (
        <ConfirmDialog
          open
          title="⚠️ Outbox 강제 SKIP — 영구 데이터 드롭"
          body={
            <>
              <div className="mono" style={{ fontSize: 12 }}>
                id={confirm.row.id} topic={confirm.row.topic}
              </div>
              <p style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>
                이 행은 <strong>영원히 Kafka 로 발행되지 않습니다</strong>. downstream consumer
                (matcher / candle / fanout / notification / audit) 는 이 메시지를 절대 못 봅니다.
                payload 가 손상됐거나 비즈니스적으로 reconcile 끝낸 경우만 사용하세요.
              </p>
              <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-3)' }}>
                <code>retry</code> 가 가능한 케이스라면 retry 를 우선하세요. 사유는 감사 로그에 기록됩니다.
              </p>
            </>
          }
          challengeText={confirm.row.id}
          challengeLabel={`확인하려면 outbox id (${confirm.row.id}) 를 입력하세요`}
          confirmLabel="SKIP — 영구 드롭"
          loading={skipMut.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => skipMut.mutate({ id: confirm.row.id, reason })}
        />
      )}
    </>
  );
}

/* ───────────────── small bits ───────────────── */

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
}) {
  const color =
    tone === 'danger' ? 'var(--danger)' :
    tone === 'warn' ? 'var(--warn, #d97706)' :
    tone === 'ok' ? 'var(--ok)' :
    'var(--text-2)';
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '12px 16px',
      }}
    >
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontWeight: 600 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 22, fontWeight: 700, color, fontFamily: 'var(--font-num)' }}>
        {value}
      </div>
    </div>
  );
}

function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d`;
}

const labelStyle: React.CSSProperties = {
  fontSize: 10.5,
  color: 'var(--text-3)',
  fontWeight: 600,
  marginBottom: 4,
};
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: 12,
};
const btnSecondary: React.CSSProperties = {
  padding: '1px 6px',
  fontSize: 10.5,
  border: '1px solid var(--border)',
  borderRadius: 3,
  background: 'transparent',
};
const btnPrimary: React.CSSProperties = {
  padding: '1px 6px',
  fontSize: 10.5,
  border: '1px solid var(--accent, #2563eb)',
  color: 'var(--accent, #2563eb)',
  borderRadius: 3,
  background: 'transparent',
};
const btnDanger: React.CSSProperties = {
  padding: '1px 6px',
  fontSize: 10.5,
  border: '1px solid var(--danger)',
  color: 'var(--danger)',
  borderRadius: 3,
  background: 'transparent',
};
const preStyle: React.CSSProperties = {
  background: 'var(--card)',
  padding: 8,
  borderRadius: 4,
  fontSize: 11,
  fontFamily: 'var(--font-num)',
  overflow: 'auto',
  maxHeight: 240,
  border: '1px solid var(--border-soft)',
  margin: 0,
};

function In({ label, v, on }: { label: string; v: string; on: (v: string) => void }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <input value={v} onChange={(e) => on(e.target.value)} style={inputStyle} />
    </div>
  );
}
