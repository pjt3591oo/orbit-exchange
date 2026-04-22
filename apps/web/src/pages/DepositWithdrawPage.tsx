import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuthStore } from '../store/auth';
import { T, fmtNum } from '../design/tokens';
import { Chip } from '../design/atoms';

interface WalletRow { asset: string; balance: string; locked: string; }
interface MarketRow { baseAsset: string; quoteAsset: string; }

export function DepositWithdrawPage() {
  const token = useAuthStore((s) => s.accessToken);
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [asset, setAsset] = useState('KRW');
  const [amount, setAmount] = useState('1000000');

  const { data: wallets } = useQuery({
    queryKey: ['wallets'],
    queryFn: async () => (await api.get<WalletRow[]>('/wallets')).data,
    enabled: !!token,
  });
  const { data: markets } = useQuery({
    queryKey: ['markets'],
    queryFn: async () => (await api.get<MarketRow[]>('/markets')).data,
  });

  const assets = Array.from(
    new Set([
      'KRW',
      ...(markets ?? []).flatMap((m) => [m.baseAsset, m.quoteAsset]),
    ]),
  );
  const wallet = wallets?.find((w) => w.asset === asset);

  if (!token) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: T.text3 }}>
        입출금 화면을 보려면 로그인이 필요합니다.
      </div>
    );
  }

  return (
    <div style={{ padding: 'clamp(12px, 3vw, 24px)', maxWidth: 560, margin: '0 auto' }}>
      <DemoBanner />

      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 12,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {/* mode tabs */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 0,
            background: T.hover,
            borderRadius: 6,
            padding: 3,
          }}
        >
          {(
            [
              { k: 'deposit', l: '입금' },
              { k: 'withdraw', l: '출금' },
            ] as const
          ).map((x) => (
            <button
              key={x.k}
              onClick={() => setMode(x.k)}
              style={{
                border: 'none',
                background: mode === x.k ? T.card : 'transparent',
                color: mode === x.k ? T.text : T.text2,
                fontSize: 12.5,
                fontWeight: 600,
                padding: '8px 0',
                borderRadius: 4,
                cursor: 'pointer',
                boxShadow: mode === x.k ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              {x.l}
            </button>
          ))}
        </div>

        <div>
          <div style={{ fontSize: 11, color: T.text3, marginBottom: 6, fontWeight: 600 }}>
            자산 선택
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {assets.map((a) => (
              <Chip key={a} active={asset === a} onClick={() => setAsset(a)}>
                {a}
              </Chip>
            ))}
          </div>
        </div>

        {asset === 'KRW' ? (
          <>
            <div
              style={{
                background: T.brandSoft,
                border: `1px solid ${T.brandSoft}`,
                borderRadius: 8,
                padding: 14,
              }}
            >
              <div
                style={{ fontSize: 11, color: T.brandInk, fontWeight: 600, marginBottom: 4 }}
              >
                {mode === 'deposit' ? '입금 전용 계좌 (데모)' : '출금 계좌 (데모)'}
              </div>
              <div
                className="mono"
                style={{ fontSize: 16, color: T.text, fontWeight: 700 }}
              >
                케이뱅크 · 100-204-38219-4
              </div>
              <div style={{ fontSize: 11.5, color: T.text2, marginTop: 4 }}>
                예금주 · {useAuthStore.getState().email ?? '—'}
              </div>
            </div>
            <Field
              label={mode === 'deposit' ? '입금 금액 (KRW)' : '출금 금액 (KRW)'}
              value={amount}
              onChange={setAmount}
              suffix="KRW"
            />
          </>
        ) : (
          <>
            <div
              style={{
                background: T.bgAlt,
                border: `1px solid ${T.border}`,
                borderRadius: 8,
                padding: 14,
              }}
            >
              <div
                style={{ fontSize: 11, color: T.text3, fontWeight: 600, marginBottom: 8 }}
              >
                {mode === 'deposit' ? `${asset} 입금 주소 (데모)` : '출금 주소 입력'}
              </div>
              {mode === 'deposit' ? (
                <div
                  className="mono"
                  style={{
                    fontSize: 12,
                    color: T.text,
                    wordBreak: 'break-all',
                    fontWeight: 500,
                  }}
                >
                  orb1q{asset.toLowerCase()}x8k3p2m9nrlv7hqz4t6fwxe
                </div>
              ) : (
                <Field label="" value="" onChange={() => {}} placeholder="0x..." />
              )}
            </div>
            <Field
              label={`수량 (${asset})`}
              value={amount}
              onChange={setAmount}
              suffix={asset}
            />
          </>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 11.5,
            color: T.text3,
            padding: '6px 0',
          }}
        >
          <span>사용 가능 잔액</span>
          <span className="mono" style={{ color: T.text, fontWeight: 600 }}>
            {wallet
              ? asset === 'KRW'
                ? `₩${fmtNum(wallet.balance, 0)}`
                : `${Number(wallet.balance).toFixed(8)} ${asset}`
              : '—'}
          </span>
        </div>

        <button
          disabled
          style={{
            background: T.text3,
            color: '#fff',
            border: 'none',
            fontSize: 13,
            fontWeight: 700,
            padding: '11px 0',
            borderRadius: 6,
            cursor: 'not-allowed',
            letterSpacing: 0.5,
          }}
        >
          {mode === 'deposit' ? '입금 요청' : '출금 신청'} (데모 · 미구현)
        </button>
      </div>
    </div>
  );
}

function DemoBanner() {
  return (
    <div
      style={{
        background: T.warnBg,
        color: T.warn,
        borderRadius: 8,
        padding: '10px 14px',
        fontSize: 12,
        fontWeight: 600,
        marginBottom: 14,
        lineHeight: 1.5,
      }}
    >
      입출금은 데모 화면입니다. 실제 계좌/지갑과 연결되어 있지 않으며 버튼을 눌러도 잔고가 변하지 않습니다.
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  suffix,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  placeholder?: string;
}) {
  return (
    <div>
      {label && (
        <div style={{ fontSize: 11, color: T.text3, fontWeight: 600, marginBottom: 5 }}>
          {label}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          border: `1px solid ${T.border}`,
          borderRadius: 6,
          background: T.card,
        }}
      >
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontFamily: 'var(--font-num)',
            fontVariantNumeric: 'tabular-nums',
            fontSize: 13,
            color: T.text,
            padding: '9px 10px',
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
