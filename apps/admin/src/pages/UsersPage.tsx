import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { PageHeader, Card } from '../components/PageHeader';
import { Pagination, useCursorPagination } from '../components/Pagination';

interface UserRow {
  id: string;
  email: string;
  frozen: boolean;
  createdAt: string;
  orderCount: number;
  walletCount: number;
}

export function UsersPage() {
  const [q, setQ] = useState('');
  const { currentCursor, page, pushNext, popPrev, hasPrev } = useCursorPagination([q]);
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin-users', q, currentCursor],
    queryFn: async () =>
      (
        await api.get<{ items: UserRow[]; nextCursor: string | null }>('/users', {
          params: { q, ...(currentCursor && { cursor: currentCursor }) },
        })
      ).data,
  });

  return (
    <>
      <PageHeader
        title="사용자"
        subtitle="이메일 또는 user id 로 검색"
        right={
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="email or id…"
            style={{
              padding: '6px 10px',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 12,
              width: 240,
            }}
          />
        }
      />
      <Card padded={false}>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>ID</th>
              <th>가입일</th>
              <th style={{ textAlign: 'right' }}>주문 수</th>
              <th style={{ textAlign: 'right' }}>지갑 수</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} style={{ color: 'var(--text-3)', padding: 16 }}>
                  로딩…
                </td>
              </tr>
            )}
            {data?.items.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link to={`/users/${u.id}`} style={{ color: 'var(--brand-ink)' }}>
                    {u.email}
                  </Link>
                </td>
                <td className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {u.id}
                </td>
                <td>{new Date(u.createdAt).toLocaleString()}</td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {u.orderCount}
                </td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {u.walletCount}
                </td>
                <td>
                  {u.frozen ? (
                    <span
                      style={{
                        background: 'var(--danger-bg)',
                        color: 'var(--danger)',
                        padding: '2px 6px',
                        borderRadius: 3,
                        fontSize: 10.5,
                        fontWeight: 700,
                      }}
                    >
                      FROZEN
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-3)', fontSize: 11 }}>active</span>
                  )}
                </td>
              </tr>
            ))}
            {data?.items.length === 0 && (
              <tr>
                <td colSpan={6} style={{ color: 'var(--text-3)', padding: 16 }}>
                  검색 결과가 없습니다.
                </td>
              </tr>
            )}
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
