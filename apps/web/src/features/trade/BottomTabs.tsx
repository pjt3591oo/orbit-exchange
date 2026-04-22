import { CSSProperties, ReactNode, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuthStore } from '../../store/auth';
import { T, fmtKRW, fmtNum, fmtPct, priceDigits } from '../../design/tokens';
import { Tag } from '../../design/atoms';

type TabKey = 'open' | 'history' | 'assets';

interface Order {
  id: string;
  market: string;
  side: 'BID' | 'ASK';
  type: 'LIMIT' | 'MARKET';
  price: string | null;
  quantity: string;
  leaveQty: string;
  filledQty: string;
  status: 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  createdAt: string;
}
interface WalletRow { asset: string; balance: string; locked: string; }
interface MarketRow { symbol: string; baseAsset: string; quoteAsset: string; }

export function BottomTabs({ symbol }: { symbol: string }) {
  const token = useAuthStore((s) => s.accessToken);
  const [tab, setTab] = useState<TabKey>('open');
  const [onlyThis, setOnlyThis] = useState(true);

  const tabs: Array<{ k: TabKey; l: string }> = [
    { k: 'open', l: '미체결' },
    { k: 'history', l: '주문 내역' },
    { k: 'assets', l: '자산' },
  ];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: T.card,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: `1px solid ${T.border}`,
          padding: '0 8px',
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            style={{
              border: 'none',
              background: 'transparent',
              fontSize: 12.5,
              fontWeight: 600,
              color: tab === t.k ? T.text : T.text3,
              padding: '10px 14px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              borderBottom: tab === t.k ? `2px solid ${T.brand}` : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            {t.l}
          </button>
        ))}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingRight: 8,
          }}
        >
          {tab !== 'assets' && (
            <label
              style={{
                fontSize: 11,
                color: T.text3,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <input
                type="checkbox"
                checked={onlyThis}
                onChange={(e) => setOnlyThis(e.target.checked)}
                style={{ accentColor: T.brand }}
              />
              현재 종목만
            </label>
          )}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {!token ? (
          <EmptyRow text="로그인 후 확인할 수 있습니다" />
        ) : tab === 'open' ? (
          <OpenOrders symbol={onlyThis ? symbol : undefined} />
        ) : tab === 'history' ? (
          <OrderHistory symbol={onlyThis ? symbol : undefined} />
        ) : (
          <Assets />
        )}
      </div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: 30,
        textAlign: 'center',
        color: T.text3,
        fontSize: 12.5,
      }}
    >
      {text}
    </div>
  );
}

function OpenOrders({ symbol }: { symbol?: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['openOrders', symbol ?? 'all'],
    queryFn: async () =>
      (await api.get<Order[]>('/orders/open', { params: symbol ? { market: symbol } : {} })).data,
    refetchInterval: 3000,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.delete(`/orders/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['openOrders'] });
      qc.invalidateQueries({ queryKey: ['wallets'] });
    },
  });

  if (!data || data.length === 0) return <EmptyRow text="미체결 주문이 없습니다" />;

  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <Th>주문시각</Th>
          <Th>마켓</Th>
          <Th>타입</Th>
          <Th>구분</Th>
          <Th align="right">가격</Th>
          <Th align="right">수량</Th>
          <Th align="right">체결량</Th>
          <Th align="right">액션</Th>
        </tr>
      </thead>
      <tbody>
        {data.map((o) => (
          <tr key={o.id}>
            <Td mono>{new Date(o.createdAt).toLocaleTimeString('ko-KR', { hour12: false })}</Td>
            <Td weight={600}>{o.market}</Td>
            <Td>{o.type === 'LIMIT' ? '지정가' : '시장가'}</Td>
            <Td color={o.side === 'BID' ? T.up : T.down} weight={700}>
              {o.side === 'BID' ? '매수' : '매도'}
            </Td>
            <Td mono align="right">
              {o.price ? fmtNum(o.price, priceDigits(Number(o.price))) : '-'}
            </Td>
            <Td mono align="right">{Number(o.quantity).toFixed(4)}</Td>
            <Td mono align="right" color={T.text3}>
              {Number(o.filledQty).toFixed(4)}
            </Td>
            <Td align="right">
              <button
                onClick={() => cancel.mutate(o.id)}
                disabled={cancel.isPending}
                style={{
                  border: `1px solid ${T.border}`,
                  background: T.card,
                  fontSize: 11,
                  color: T.text2,
                  padding: '3px 8px',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                취소
              </button>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OrderHistory({ symbol }: { symbol?: string }) {
  const { data } = useQuery({
    queryKey: ['orderHistory', symbol ?? 'all'],
    queryFn: async () =>
      (await api.get<Order[]>('/orders/history', { params: symbol ? { market: symbol } : {} })).data,
    refetchInterval: 5000,
  });
  if (!data || data.length === 0) return <EmptyRow text="주문 내역이 없습니다" />;

  const statusTone = (s: Order['status']) =>
    s === 'FILLED' ? 'ok' : s === 'CANCELLED' ? 'neutral' : s === 'REJECTED' ? 'warn' : 'brand';
  const statusText = (s: Order['status']) =>
    ({ OPEN: '대기', PARTIAL: '일부', FILLED: '체결', CANCELLED: '취소', REJECTED: '거부' }[s]);

  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <Th>시각</Th>
          <Th>마켓</Th>
          <Th>타입</Th>
          <Th>구분</Th>
          <Th align="right">가격</Th>
          <Th align="right">수량</Th>
          <Th>상태</Th>
        </tr>
      </thead>
      <tbody>
        {data.map((o) => (
          <tr key={o.id}>
            <Td mono>
              {new Date(o.createdAt).toLocaleString('ko-KR', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })}
            </Td>
            <Td weight={600}>{o.market}</Td>
            <Td>{o.type === 'LIMIT' ? '지정가' : '시장가'}</Td>
            <Td color={o.side === 'BID' ? T.up : T.down} weight={700}>
              {o.side === 'BID' ? '매수' : '매도'}
            </Td>
            <Td mono align="right">
              {o.price ? fmtNum(o.price, priceDigits(Number(o.price))) : '-'}
            </Td>
            <Td mono align="right">{Number(o.quantity).toFixed(4)}</Td>
            <Td>
              <Tag tone={statusTone(o.status)}>{statusText(o.status)}</Tag>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Assets() {
  const { data: wallets } = useQuery({
    queryKey: ['wallets'],
    queryFn: async () => (await api.get<WalletRow[]>('/wallets')).data,
    refetchInterval: 3000,
  });
  const { data: markets } = useQuery({
    queryKey: ['markets'],
    queryFn: async () => (await api.get<MarketRow[]>('/markets')).data,
  });
  if (!wallets || wallets.length === 0) return <EmptyRow text="자산이 없습니다" />;

  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <Th>자산</Th>
          <Th align="right">보유수량</Th>
          <Th align="right">잠금</Th>
          <Th align="right">합계</Th>
        </tr>
      </thead>
      <tbody>
        {wallets.map((w) => {
          const total = Number(w.balance) + Number(w.locked);
          const isKRW = w.asset === 'KRW';
          return (
            <tr key={w.asset}>
              <Td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 6,
                      background: T.brandSoft,
                      color: T.brandInk,
                      fontWeight: 800,
                      fontSize: 10,
                      letterSpacing: 0.3,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {w.asset.slice(0, 4)}
                  </div>
                  <span style={{ fontWeight: 600, color: T.text }}>{w.asset}</span>
                </div>
              </Td>
              <Td mono align="right">{isKRW ? fmtNum(w.balance, 0) : Number(w.balance).toFixed(8)}</Td>
              <Td mono align="right" color={T.text3}>
                {isKRW ? fmtNum(w.locked, 0) : Number(w.locked).toFixed(8)}
              </Td>
              <Td mono align="right" weight={700}>
                {isKRW ? fmtKRW(total) : total.toFixed(8)}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const tableStyle: CSSProperties = {
  width: '100%',
  minWidth: 640,
  borderCollapse: 'separate',
  borderSpacing: 0,
  fontFamily: 'inherit',
};

function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      style={{
        textAlign: align,
        fontWeight: 600,
        fontSize: 11,
        color: T.text3,
        padding: '10px 14px',
        borderBottom: `1px solid ${T.borderSoft}`,
        letterSpacing: 0.2,
        background: T.bgAlt,
        position: 'sticky',
        top: 0,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  mono,
  color,
  weight,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  mono?: boolean;
  color?: string;
  weight?: number;
}) {
  return (
    <td
      style={{
        textAlign: align,
        fontFamily: mono ? 'var(--font-num)' : 'inherit',
        fontVariantNumeric: mono ? 'tabular-nums' : 'normal',
        fontSize: 12,
        color: color || T.text,
        fontWeight: weight || 400,
        padding: '9px 14px',
        borderBottom: `1px solid ${T.borderSoft}`,
      }}
    >
      {children}
    </td>
  );
}
