import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import Decimal from 'decimal.js';
import { api } from '../../lib/api';
import { useAuthStore } from '../../store/auth';
import { T, fmtNum } from '../../design/tokens';
import { Chip, sideTabStyle } from '../../design/atoms';

type UiSide = 'buy' | 'sell';
type UiMode = 'limit' | 'market';

interface MarketInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: string;
  stepSize: string;
  minNotional: string;
  takerFeeBp: number;
  makerFeeBp: number;
}
interface WalletRow { asset: string; balance: string; locked: string; }

export function OrderForm({
  symbol,
  pickedPrice,
}: {
  symbol: string;
  pickedPrice: string | null;
}) {
  const token = useAuthStore((s) => s.accessToken);
  const qc = useQueryClient();
  const [side, setSide] = useState<UiSide>('buy');
  const [mode, setMode] = useState<UiMode>('limit');
  const [price, setPrice] = useState<string>('');
  const [qty, setQty] = useState<string>('');
  const [pct, setPct] = useState<number | null>(null);
  const [toast, setToast] = useState<{ kind: 'up' | 'down' | 'err'; text: string } | null>(null);

  const { data: markets } = useQuery({
    queryKey: ['markets'],
    queryFn: async () => (await api.get<MarketInfo[]>('/markets')).data,
  });
  const market = markets?.find((m) => m.symbol === symbol);

  const { data: wallets } = useQuery({
    queryKey: ['wallets'],
    queryFn: async () => (await api.get<WalletRow[]>('/wallets')).data,
    enabled: !!token,
    refetchInterval: 3000,
  });

  useEffect(() => {
    if (pickedPrice) setPrice(pickedPrice);
  }, [pickedPrice]);

  // reset on symbol change
  useEffect(() => {
    setPrice('');
    setQty('');
    setPct(null);
  }, [symbol]);

  const base = market ? wallets?.find((w) => w.asset === market.baseAsset) : undefined;
  const quote = market ? wallets?.find((w) => w.asset === market.quoteAsset) : undefined;

  const totalNotional = useMemo(() => {
    if (!price || !qty) return '0';
    try { return new Decimal(price).mul(qty).toFixed(0); } catch { return '0'; }
  }, [price, qty]);

  const onPct = (p: number) => {
    setPct(p);
    if (!market) return;
    if (side === 'buy') {
      const bal = new Decimal(quote?.balance ?? 0).mul(p).div(100);
      const px = price ? new Decimal(price) : null;
      if (px && px.gt(0)) {
        setQty(bal.div(px).toFixed(8));
      }
    } else {
      setQty(new Decimal(base?.balance ?? 0).mul(p).div(100).toFixed(8));
    }
  };

  const submit = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        market: symbol,
        side: side === 'buy' ? 'BID' : 'ASK',
        type: mode.toUpperCase(),
        quantity: qty,
      };
      if (mode === 'limit') body.price = price;
      const { data } = await api.post('/orders', body);
      return data;
    },
    onSuccess: () => {
      setToast({
        kind: side === 'buy' ? 'up' : 'down',
        text: `${side === 'buy' ? '매수' : '매도'} 주문 접수 · ${qty} ${market?.baseAsset ?? ''}${mode === 'limit' ? ` @ ${fmtNum(price, 0)}` : ''}`,
      });
      setQty('');
      setPct(null);
      qc.invalidateQueries({ queryKey: ['wallets'] });
      qc.invalidateQueries({ queryKey: ['openOrders', symbol] });
      setTimeout(() => setToast(null), 2800);
    },
    onError: (e: any) => {
      setToast({ kind: 'err', text: e?.response?.data?.message ?? '주문 실패' });
      setTimeout(() => setToast(null), 3000);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  const actionCol = side === 'buy' ? T.up : T.down;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: T.card,
        position: 'relative',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        <button onClick={() => setSide('buy')} style={sideTabStyle(side === 'buy', T.up)}>매수</button>
        <button onClick={() => setSide('sell')} style={sideTabStyle(side === 'sell', T.down)}>매도</button>
      </div>

      {!token ? (
        <div style={{ padding: 20, color: T.text3, fontSize: 12.5, textAlign: 'center' }}>
          주문을 하려면{' '}
          <Link to="/login" style={{ color: T.brandInk, fontWeight: 700 }}>
            로그인
          </Link>
          이 필요합니다.
        </div>
      ) : (
        <form
          onSubmit={onSubmit}
          style={{
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            flex: 1,
            minHeight: 0,
          }}
        >
          <div style={{ display: 'flex', gap: 4 }}>
            {([
              { k: 'limit', l: '지정가' },
              { k: 'market', l: '시장가' },
            ] as const).map((m) => (
              <Chip
                key={m.k}
                active={mode === m.k}
                onClick={() => setMode(m.k)}
                style={{ padding: '5px 10px', fontSize: 11.5 }}
              >
                {m.l}
              </Chip>
            ))}
          </div>

          <FieldRow label="주문가능">
            <span
              className="mono"
              style={{ fontSize: 12, color: T.text, fontWeight: 600 }}
            >
              {side === 'buy'
                ? quote
                  ? `${market?.quoteAsset === 'KRW' ? '₩' : ''}${fmtNum(quote.balance, 0)}`
                  : '—'
                : base
                  ? `${fmtNum(base.balance, 4)} ${market?.baseAsset ?? ''}`
                  : '—'}
            </span>
          </FieldRow>

          <NumField
            label={`가격 (${market?.quoteAsset ?? ''})`}
            value={price}
            onChange={setPrice}
            disabled={mode === 'market'}
            suffix={market?.quoteAsset ?? ''}
          />

          <NumField
            label="수량"
            value={qty}
            onChange={(v) => {
              setQty(v);
              setPct(null);
            }}
            suffix={market?.baseAsset ?? ''}
          />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4 }}>
            {[10, 25, 50, 100].map((p) => (
              <button
                type="button"
                key={p}
                onClick={() => onPct(p)}
                style={{
                  border: `1px solid ${pct === p ? T.text : T.border}`,
                  background: pct === p ? T.text : T.card,
                  color: pct === p ? '#fff' : T.text2,
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '5px 0',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                {p}%
              </button>
            ))}
          </div>

          <FieldRow label="주문총액">
            <span
              className="mono"
              style={{ fontSize: 13, color: T.text, fontWeight: 700 }}
            >
              {market?.quoteAsset === 'KRW' ? '₩ ' : ''}
              {fmtNum(totalNotional, 0)}
            </span>
          </FieldRow>

          <div
            style={{
              background: T.bgAlt,
              border: `1px solid ${T.borderSoft}`,
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 10.5,
              color: T.text3,
              lineHeight: 1.5,
              marginTop: 'auto',
            }}
          >
            수수료 Maker {(market?.makerFeeBp ?? 10) / 100}% · Taker {(market?.takerFeeBp ?? 20) / 100}%
            <br />
            최소주문금액 {market ? fmtNum(market.minNotional, 0) : '—'} {market?.quoteAsset}
          </div>

          <button
            type="submit"
            disabled={submit.isPending || !qty || (mode === 'limit' && !price)}
            style={{
              background: actionCol,
              color: '#fff',
              border: 'none',
              fontSize: 14,
              fontWeight: 700,
              padding: '12px 0',
              borderRadius: 6,
              cursor: 'pointer',
              letterSpacing: 0.5,
              opacity: submit.isPending || !qty || (mode === 'limit' && !price) ? 0.6 : 1,
            }}
          >
            {submit.isPending ? '접수 중…' : `${side === 'buy' ? '매수' : '매도'} · ${market?.baseAsset ?? ''}`}
          </button>
        </form>
      )}

      {toast && (
        <div
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: 12,
            background: toast.kind === 'err' ? T.down : T.text,
            color: '#fff',
            borderRadius: 6,
            padding: '10px 12px',
            fontSize: 12,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: toast.kind === 'up' ? T.up : toast.kind === 'down' ? T.down : '#fff',
            }}
          />
          {toast.text}
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 0',
        fontSize: 11.5,
        color: T.text3,
        gap: 8,
      }}
    >
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ whiteSpace: 'nowrap' }}>{children}</span>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  disabled,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  suffix?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: T.text3, marginBottom: 4, fontWeight: 600 }}>{label}</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          border: `1px solid ${T.border}`,
          borderRadius: 6,
          background: disabled ? T.bg : T.card,
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <input
          value={disabled ? '시장가' : value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
          inputMode="decimal"
          placeholder="0"
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontFamily: 'var(--font-num)',
            fontVariantNumeric: 'tabular-nums',
            fontSize: 13,
            color: T.text,
            padding: '8px 10px',
            fontWeight: 500,
          }}
        />
        {suffix && (
          <span style={{ fontSize: 11, color: T.text3, padding: '0 10px', fontWeight: 600 }}>
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}
