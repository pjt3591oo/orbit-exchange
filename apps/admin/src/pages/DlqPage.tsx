import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { hasAnyRole } from '../lib/keycloak';
import { PageHeader, Card } from '../components/PageHeader';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface DlqRow {
  id: string;
  originalTopic: string;
  originalPartition: number;
  originalOffset: string;
  worker: string;
  lastError: string;
  attempt: number;
  enqueuedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  resolvedBy: string | null;
}

interface DlqDetail extends DlqRow {
  payloadText: string | null;
  payloadJson: unknown;
  payloadBytes: number;
  headers: Record<string, string>;
}

/**
 * ADR-0004 §D6 — DLQ inspection + replay surface.
 *
 * Read access: SUPPORT_READ. Replay/dismiss: MARKET_OPS.
 * Both mutations require a reason and prompt a confirmation dialog —
 * AdminAuditLog records who, what, why.
 */
export function DlqPage() {
  const canMutate = hasAnyRole(['MARKET_OPS']);
  const [resolved, setResolved] = useState<'false' | 'true' | 'all'>('false');
  const [worker, setWorker] = useState('');
  const [originalTopic, setOriginalTopic] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: 'replay'; row: DlqRow }
    | { kind: 'dismiss'; row: DlqRow }
    | null
  >(null);

  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['admin-dlq', resolved, worker, originalTopic],
    queryFn: async () =>
      (await api.get<{ items: DlqRow[]; nextCursor: string | null }>('/dlq', {
        params: {
          resolved,
          ...(worker && { worker }),
          ...(originalTopic && { originalTopic }),
        },
      })).data,
  });

  const detail = useQuery({
    queryKey: ['admin-dlq-detail', expanded],
    queryFn: async () =>
      expanded
        ? (await api.get<DlqDetail>(`/dlq/${expanded}`)).data
        : null,
    enabled: !!expanded,
  });

  const replayMut = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      (await api.post(`/dlq/${id}/replay`, { reason })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-dlq'] });
      setConfirm(null);
    },
  });

  const dismissMut = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      (await api.post(`/dlq/${id}/dismiss`, { reason })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-dlq'] });
      setConfirm(null);
    },
  });

  return (
    <>
      <PageHeader
        title="DLQ"
        subtitle="처리 실패 메시지 — 원본 토픽으로 replay 또는 dismiss"
      />
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr) auto', gap: 12, alignItems: 'end' }}>
          <div>
            <div style={labelStyle}>상태</div>
            <select
              value={resolved}
              onChange={(e) => setResolved(e.target.value as typeof resolved)}
              style={inputStyle}
            >
              <option value="false">미해결</option>
              <option value="true">해결됨</option>
              <option value="all">전체</option>
            </select>
          </div>
          <In label="worker (e.g. notification)" v={worker} on={setWorker} />
          <In label="originalTopic" v={originalTopic} on={setOriginalTopic} />
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
              <th>시각</th>
              <th>worker</th>
              <th>원본 토픽</th>
              <th>partition / offset</th>
              <th>attempt</th>
              <th>에러</th>
              <th>상태</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr><td colSpan={8} style={{ padding: 12, color: 'var(--text-3)' }}>로딩…</td></tr>
            )}
            {list.data?.items.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 12, color: 'var(--text-3)' }}>비어있음 ✓</td></tr>
            )}
            {list.data?.items.map((r) => (
              <>
                <tr key={r.id}>
                  <td style={{ fontSize: 11 }}>{new Date(r.enqueuedAt).toLocaleString()}</td>
                  <td>
                    <code style={badgeStyle}>{r.worker}</code>
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>{r.originalTopic}</td>
                  <td className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    {r.originalPartition} / {r.originalOffset}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>{r.attempt}</td>
                  <td style={{ fontSize: 11, maxWidth: 280, color: 'var(--danger)' }}
                    title={r.lastError}>
                    {r.lastError.length > 60 ? r.lastError.slice(0, 60) + '…' : r.lastError}
                  </td>
                  <td style={{ fontSize: 11 }}>
                    {r.resolvedAt ? (
                      <span style={{ color: 'var(--text-3)' }}>
                        {r.resolution} <small>({new Date(r.resolvedAt).toLocaleString()})</small>
                      </span>
                    ) : (
                      <span style={{ color: 'var(--danger)' }}>● 미해결</span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                        style={btnSecondary}
                      >
                        {expanded === r.id ? '접기' : '상세'}
                      </button>
                      {canMutate && !r.resolvedAt && (
                        <>
                          <button
                            onClick={() => setConfirm({ kind: 'replay', row: r })}
                            style={btnDanger}
                          >
                            replay
                          </button>
                          <button
                            onClick={() => setConfirm({ kind: 'dismiss', row: r })}
                            style={btnSecondary}
                          >
                            dismiss
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {expanded === r.id && (
                  <tr key={`${r.id}-detail`}>
                    <td colSpan={8} style={{ background: 'var(--bg-alt)', padding: 12 }}>
                      {detail.isLoading || !detail.data ? (
                        <div style={{ color: 'var(--text-3)' }}>로딩…</div>
                      ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                          <div>
                            <div style={labelStyle}>payload ({detail.data.payloadBytes} bytes)</div>
                            <pre style={preStyle}>
                              {detail.data.payloadJson
                                ? JSON.stringify(detail.data.payloadJson, null, 2)
                                : detail.data.payloadText ?? '(binary)'}
                            </pre>
                          </div>
                          <div>
                            <div style={labelStyle}>headers</div>
                            <pre style={preStyle}>
                              {JSON.stringify(detail.data.headers, null, 2)}
                            </pre>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </Card>

      {confirm && (
        <ConfirmDialog
          open
          title={
            confirm.kind === 'replay'
              ? `DLQ 메시지 replay → ${confirm.row.originalTopic}`
              : `DLQ 메시지 dismiss`
          }
          body={
            <>
              <div>
                <code style={badgeStyle}>{confirm.row.worker}</code>{' '}
                <span style={{ color: 'var(--text-3)' }}>
                  {confirm.row.originalTopic} #{confirm.row.originalOffset}
                </span>
              </div>
              {confirm.kind === 'replay' ? (
                <p style={{ marginTop: 8, fontSize: 12 }}>
                  원본 메시지를 <strong>{confirm.row.originalTopic}</strong> 토픽으로 다시
                  발행합니다. 처리 시 같은 에러가 또 나면 새로운 DLQ 행이 생성됩니다.
                </p>
              ) : (
                <p style={{ marginTop: 8, fontSize: 12 }}>
                  메시지를 <strong>처리 불가</strong> 로 마킹합니다. Kafka 토픽의 원본은 그대로
                  남으며, DB 행만 resolved 상태로 바뀝니다.
                </p>
              )}
            </>
          }
          challengeText={confirm.row.id}
          challengeLabel={`확인하려면 DLQ id (${confirm.row.id}) 를 입력하세요`}
          confirmLabel={confirm.kind === 'replay' ? 'replay 실행' : 'dismiss 실행'}
          loading={replayMut.isPending || dismissMut.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => {
            if (confirm.kind === 'replay') {
              replayMut.mutate({ id: confirm.row.id, reason });
            } else {
              dismissMut.mutate({ id: confirm.row.id, reason });
            }
          }}
        />
      )}
    </>
  );
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
const badgeStyle: React.CSSProperties = {
  background: 'var(--bg-alt)',
  padding: '1px 5px',
  borderRadius: 3,
  fontSize: 11,
};
const btnSecondary: React.CSSProperties = {
  padding: '1px 6px',
  fontSize: 10.5,
  border: '1px solid var(--border)',
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
