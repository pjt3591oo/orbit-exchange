import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader, Card } from '../components/PageHeader';

interface AuditRow {
  id: string;
  adminId: string;
  adminEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  ua: string | null;
  createdAt: string;
}

export function AuditPage() {
  const [filter, setFilter] = useState({ actor: '', action: '', targetType: '', targetId: '' });
  const { data, isLoading } = useQuery({
    queryKey: ['admin-audit', filter],
    queryFn: async () =>
      (await api.get<{ items: AuditRow[]; nextCursor: string | null }>('/audit', {
        params: Object.fromEntries(Object.entries(filter).filter(([_, v]) => v)),
      })).data,
  });

  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <>
      <PageHeader title="감사 로그" subtitle="모든 어드민 mutation 의 append-only 기록" />
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <In label="actor (email or id)" v={filter.actor}
            on={(v) => setFilter({ ...filter, actor: v })} />
          <In label="action (e.g. wallet.adjust)" v={filter.action}
            on={(v) => setFilter({ ...filter, action: v })} />
          <In label="targetType" v={filter.targetType}
            on={(v) => setFilter({ ...filter, targetType: v })} />
          <In label="targetId" v={filter.targetId}
            on={(v) => setFilter({ ...filter, targetId: v })} />
        </div>
      </Card>
      <Card padded={false}>
        <table>
          <thead>
            <tr>
              <th>시각</th>
              <th>actor</th>
              <th>action</th>
              <th>target</th>
              <th>사유</th>
              <th>IP</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} style={{ padding: 12, color: 'var(--text-3)' }}>로딩…</td></tr>}
            {data?.items.map((r) => (
              <>
                <tr key={r.id}>
                  <td style={{ fontSize: 11 }}>{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{r.adminEmail || r.adminId.slice(-8)}</td>
                  <td>
                    <code style={{
                      background: 'var(--bg-alt)', padding: '1px 5px', borderRadius: 3, fontSize: 11,
                    }}>{r.action}</code>
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {r.targetType}/{r.targetId.length > 20 ? r.targetId.slice(0, 20) + '…' : r.targetId}
                  </td>
                  <td style={{ fontSize: 11, color: 'var(--text-2)' }}>{r.reason ?? '—'}</td>
                  <td className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.ip ?? '—'}</td>
                  <td>
                    <button
                      onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                      style={{
                        padding: '1px 6px', fontSize: 10.5, border: '1px solid var(--border)',
                        borderRadius: 3, background: 'transparent',
                      }}
                    >
                      {expanded === r.id ? '접기' : '상세'}
                    </button>
                  </td>
                </tr>
                {expanded === r.id && (
                  <tr key={`${r.id}-detail`}>
                    <td colSpan={7} style={{ background: 'var(--bg-alt)', padding: 12 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div>
                          <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontWeight: 600, marginBottom: 4 }}>before</div>
                          <pre style={preStyle}>{JSON.stringify(r.before, null, 2)}</pre>
                        </div>
                        <div>
                          <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontWeight: 600, marginBottom: 4 }}>after</div>
                          <pre style={preStyle}>{JSON.stringify(r.after, null, 2)}</pre>
                        </div>
                      </div>
                      {r.ua && (
                        <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--text-3)' }}>
                          UA: {r.ua}
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
    </>
  );
}

function In({ label, v, on }: { label: string; v: string; on: (v: string) => void }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <input value={v} onChange={(e) => on(e.target.value)}
        style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }} />
    </div>
  );
}

const preStyle: React.CSSProperties = {
  background: 'var(--card)', padding: 8, borderRadius: 4, fontSize: 11,
  fontFamily: 'var(--font-num)', overflow: 'auto', maxHeight: 200,
  border: '1px solid var(--border-soft)', margin: 0,
};
