import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { PageHeader, Card } from '../components/PageHeader';
import { hasRole } from '../lib/keycloak';

interface MarketDetail {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: string;
  stepSize: string;
  minNotional: string;
  takerFeeBp: number;
  makerFeeBp: number;
  enabled: boolean;
  orderbook: { asks?: { price: string; quantity: string }[]; bids?: { price: string; quantity: string }[] } | null;
}

export function MarketDetailPage() {
  const { symbol } = useParams<{ symbol: string }>();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<MarketDetail>({
    queryKey: ['admin-market', symbol],
    queryFn: async () => (await api.get<MarketDetail>(`/markets/${symbol}`)).data,
    enabled: !!symbol,
    refetchInterval: 5000,
  });

  const canEdit = hasRole('MARKET_OPS');
  const [form, setForm] = useState<Partial<MarketDetail> & { reason?: string }>({});
  useEffect(() => {
    if (data) {
      setForm({
        enabled: data.enabled,
        tickSize: data.tickSize,
        stepSize: data.stepSize,
        minNotional: data.minNotional,
        takerFeeBp: data.takerFeeBp,
        makerFeeBp: data.makerFeeBp,
      });
    }
  }, [data?.symbol]);

  const updateMut = useMutation({
    mutationFn: async (payload: typeof form) => api.patch(`/markets/${symbol}`, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-market', symbol] }),
  });

  if (isLoading) return <div style={{ padding: 24 }}>로딩…</div>;
  if (!data) return null;

  const dirty = JSON.stringify({ ...form, reason: undefined }) !==
    JSON.stringify({
      enabled: data.enabled,
      tickSize: data.tickSize,
      stepSize: data.stepSize,
      minNotional: data.minNotional,
      takerFeeBp: data.takerFeeBp,
      makerFeeBp: data.makerFeeBp,
    });

  return (
    <>
      <PageHeader
        title={data.symbol}
        subtitle={`${data.baseAsset} / ${data.quoteAsset} · ${data.enabled ? 'enabled' : 'disabled'}`}
      />

      <Card>
        <h3 style={{ margin: 0, fontSize: 13 }}>설정</h3>
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          <Field label="enabled">
            <select
              disabled={!canEdit}
              value={String(form.enabled ?? data.enabled)}
              onChange={(e) => setForm({ ...form, enabled: e.target.value === 'true' })}
              style={inputStyle}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </Field>
          <Field label="tickSize">
            <input disabled={!canEdit} value={form.tickSize ?? ''} onChange={(e) => setForm({ ...form, tickSize: e.target.value })} style={inputStyle} />
          </Field>
          <Field label="stepSize">
            <input disabled={!canEdit} value={form.stepSize ?? ''} onChange={(e) => setForm({ ...form, stepSize: e.target.value })} style={inputStyle} />
          </Field>
          <Field label="minNotional">
            <input disabled={!canEdit} value={form.minNotional ?? ''} onChange={(e) => setForm({ ...form, minNotional: e.target.value })} style={inputStyle} />
          </Field>
          <Field label="makerFeeBp">
            <input type="number" disabled={!canEdit} value={form.makerFeeBp ?? 0} onChange={(e) => setForm({ ...form, makerFeeBp: Number(e.target.value) })} style={inputStyle} />
          </Field>
          <Field label="takerFeeBp">
            <input type="number" disabled={!canEdit} value={form.takerFeeBp ?? 0} onChange={(e) => setForm({ ...form, takerFeeBp: Number(e.target.value) })} style={inputStyle} />
          </Field>
        </div>

        {canEdit && (
          <>
            <Field label="사유 (필수)" style={{ marginTop: 12 }}>
              <input
                value={form.reason ?? ''}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="감사 로그에 기록됨"
                style={inputStyle}
              />
            </Field>
            <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                disabled={!dirty || !form.reason || updateMut.isPending}
                onClick={() => updateMut.mutate(form)}
                style={{
                  padding: '6px 14px',
                  border: 'none',
                  borderRadius: 4,
                  background: dirty && form.reason ? 'var(--brand)' : 'var(--text-4)',
                  color: 'white',
                  fontWeight: 600,
                  fontSize: 12,
                }}
              >
                {updateMut.isPending ? '저장 중…' : '저장'}
              </button>
            </div>
            {updateMut.isError && (
              <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>
                {(updateMut.error as Error).message}
              </div>
            )}
          </>
        )}
      </Card>

      <Card>
        <h3 style={{ margin: 0, fontSize: 13 }}>호가창 (Redis snapshot)</h3>
        {!data.orderbook ? (
          <div style={{ marginTop: 8, color: 'var(--text-3)' }}>스냅샷 없음 (매처 idle)</div>
        ) : (
          <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>매도 (asks)</div>
              <table>
                <thead><tr><th style={{ textAlign: 'right' }}>가격</th><th style={{ textAlign: 'right' }}>수량</th></tr></thead>
                <tbody>
                  {(data.orderbook.asks ?? []).slice(-15).reverse().map((l, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ textAlign: 'right', color: 'var(--down)' }}>{l.price}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{l.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>매수 (bids)</div>
              <table>
                <thead><tr><th style={{ textAlign: 'right' }}>가격</th><th style={{ textAlign: 'right' }}>수량</th></tr></thead>
                <tbody>
                  {(data.orderbook.bids ?? []).slice(0, 15).map((l, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ textAlign: 'right', color: 'var(--up)' }}>{l.price}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{l.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={style}>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontFamily: 'var(--font-num)',
  fontSize: 12,
  background: 'var(--bg-alt)',
};
