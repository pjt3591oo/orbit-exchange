import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader, Card } from '../components/PageHeader';

interface Asset { symbol: string; name: string; decimals: number }

export function AssetsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Asset[]>({
    queryKey: ['admin-assets'],
    queryFn: async () => (await api.get<Asset[]>('/assets')).data,
  });

  const [draft, setDraft] = useState<Asset>({ symbol: '', name: '', decimals: 8 });
  const [error, setError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: async (a: Asset) => api.post('/assets', a),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-assets'] });
      setDraft({ symbol: '', name: '', decimals: 8 });
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });

  const deleteMut = useMutation({
    mutationFn: async (s: string) => api.delete(`/assets/${s}`, { data: { reason: '운영자 수동 삭제' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-assets'] }),
  });

  return (
    <>
      <PageHeader title="자산" subtitle="MARKET_OPS 권한 — 신규 자산 등록 / 미사용 자산 삭제" />

      <Card>
        <h3 style={{ margin: 0, fontSize: 13 }}>신규 자산</h3>
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr', gap: 8, alignItems: 'end' }}>
          <Field label="symbol">
            <input value={draft.symbol} onChange={(e) => setDraft({ ...draft, symbol: e.target.value.toUpperCase() })}
              placeholder="예: USDC" style={inputStyle} />
          </Field>
          <Field label="name">
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="예: USD Coin" style={inputStyle} />
          </Field>
          <Field label="decimals">
            <input type="number" value={draft.decimals}
              onChange={(e) => setDraft({ ...draft, decimals: Number(e.target.value) })} style={inputStyle} />
          </Field>
          <button
            onClick={() => createMut.mutate(draft)}
            disabled={!draft.symbol || !draft.name || createMut.isPending}
            style={{
              padding: '8px 14px', border: 'none', borderRadius: 4,
              background: 'var(--brand)', color: 'white', fontWeight: 600, fontSize: 12,
            }}
          >
            추가
          </button>
        </div>
        {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{error}</div>}
      </Card>

      <Card padded={false}>
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Name</th>
              <th style={{ textAlign: 'right' }}>Decimals</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={4} style={{ padding: 12, color: 'var(--text-3)' }}>로딩…</td></tr>}
            {data?.map((a) => (
              <tr key={a.symbol}>
                <td><strong>{a.symbol}</strong></td>
                <td>{a.name}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{a.decimals}</td>
                <td>
                  <button
                    onClick={() => {
                      if (window.confirm(`${a.symbol} 자산을 삭제합니다. 마켓 / 지갑에서 사용 중이면 실패합니다. 진행할까요?`)) {
                        deleteMut.mutate(a.symbol);
                      }
                    }}
                    style={{
                      padding: '2px 8px', fontSize: 10.5, border: '1px solid var(--danger)',
                      color: 'var(--danger)', borderRadius: 3, background: 'transparent',
                    }}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', border: '1px solid var(--border)',
  borderRadius: 4, fontSize: 12, background: 'var(--bg-alt)',
};
