import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader, Card } from '../components/PageHeader';
import { Pagination, useCursorPagination } from '../components/Pagination';

interface TradeRow {
  id: string; market: string; price: string; quantity: string;
  makerOrderId: string; takerOrderId: string;
  makerUserId: string; takerUserId: string;
  makerSide: string; takerSide: string;
  makerFee: string; takerFee: string; createdAt: string;
}

export function TradesPage() {
  const [filter, setFilter] = useState({ userId: '', market: '' });
  const { currentCursor, page, pushNext, popPrev, hasPrev } = useCursorPagination([
    filter.userId,
    filter.market,
  ]);
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin-trades', filter, currentCursor],
    queryFn: async () =>
      (await api.get<{ items: TradeRow[]; nextCursor: string | null }>('/trades', {
        params: {
          ...(filter.userId && { userId: filter.userId }),
          ...(filter.market && { market: filter.market }),
          ...(currentCursor && { cursor: currentCursor }),
        },
      })).data,
  });

  return (
    <>
      <PageHeader title="체결" subtitle="user / market / 시간 으로 검색" />
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          <Input label="user id (maker 또는 taker 매칭)" value={filter.userId}
            onChange={(v) => setFilter({ ...filter, userId: v })} />
          <Input label="market" value={filter.market}
            onChange={(v) => setFilter({ ...filter, market: v })} />
        </div>
      </Card>
      <Card padded={false}>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>마켓</th>
              <th style={{ textAlign: 'right' }}>가격</th>
              <th style={{ textAlign: 'right' }}>수량</th>
              <th>Taker</th>
              <th>Maker User</th>
              <th>Taker User</th>
              <th>시각</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={8} style={{ padding: 12, color: 'var(--text-3)' }}>로딩…</td></tr>}
            {data?.items.map((t) => (
              <tr key={t.id}>
                <td className="mono" style={{ fontSize: 11 }}>{t.id}</td>
                <td>{t.market}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{t.price}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{t.quantity}</td>
                <td>
                  <span style={{
                    fontSize: 10.5, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                    background: t.takerSide === 'BID' ? 'var(--up-bg)' : 'var(--down-bg)',
                    color: t.takerSide === 'BID' ? 'var(--up)' : 'var(--down)',
                  }}>{t.takerSide}</span>
                </td>
                <td className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{t.makerUserId.slice(-8)}</td>
                <td className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{t.takerUserId.slice(-8)}</td>
                <td style={{ fontSize: 11 }}>{new Date(t.createdAt).toLocaleString()}</td>
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
    </>
  );
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <input value={value} onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }} />
    </div>
  );
}
