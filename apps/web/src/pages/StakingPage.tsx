import { useState } from 'react';
import { T, fmtNum, fmtPct } from '../design/tokens';
import { Chip, Tag } from '../design/atoms';

interface StakePool {
  sym: string;
  name: string;
  apy: number;
  lock: string;
  tvl: number;
  min: number;
  featured: boolean;
}

const POOLS: StakePool[] = [
  { sym: 'BTC', name: 'Bitcoin', apy: 3.12, lock: '유동형', tvl: 284_300_000_000, min: 0.001, featured: true },
  { sym: 'ETH', name: 'Ethereum', apy: 5.42, lock: '유동형', tvl: 188_900_000_000, min: 0.01, featured: true },
  { sym: 'USDT', name: 'Tether', apy: 8.10, lock: '30일 고정', tvl: 92_400_000_000, min: 100, featured: true },
  { sym: 'BTC', name: 'Bitcoin (장기)', apy: 6.20, lock: '90일 고정', tvl: 48_100_000_000, min: 0.01, featured: false },
  { sym: 'ETH', name: 'Ethereum (장기)', apy: 9.40, lock: '90일 고정', tvl: 34_700_000_000, min: 0.1, featured: false },
];

export function StakingPage() {
  const [tab, setTab] = useState<'all' | 'featured'>('all');
  const list = POOLS.filter((p) => (tab === 'featured' ? p.featured : true));

  return (
    <div style={{ padding: 'clamp(12px, 3vw, 24px)', maxWidth: 960, margin: '0 auto' }}>
      <DemoBanner />

      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 14,
        }}
      >
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>스테이킹</div>
          <div style={{ fontSize: 12, color: T.text3, marginTop: 4 }}>
            보유 자산을 예치하고 매일 리워드를 수령하세요.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <Chip active={tab === 'all'} onClick={() => setTab('all')}>전체</Chip>
          <Chip active={tab === 'featured'} onClick={() => setTab('featured')}>추천</Chip>
        </div>
      </div>

      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['자산', 'APY', '락업', '최소 수량', 'TVL', ''].map((h, i) => (
                <th
                  key={h + i}
                  style={{
                    textAlign: i < 1 ? 'left' : 'right',
                    fontSize: 11,
                    color: T.text3,
                    fontWeight: 600,
                    padding: '10px 14px',
                    background: T.bgAlt,
                    borderBottom: `1px solid ${T.borderSoft}`,
                    letterSpacing: 0.2,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((p, i) => (
              <tr key={i}>
                <td
                  style={{
                    padding: '14px',
                    borderBottom: `1px solid ${T.borderSoft}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        background: T.brandSoft,
                        color: T.brandInk,
                        fontWeight: 800,
                        fontSize: 11,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {p.sym}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, color: T.text, lineHeight: 1.1 }}>
                        {p.sym}
                      </div>
                      <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>
                        {p.name}
                      </div>
                    </div>
                    {p.featured && (
                      <div style={{ marginLeft: 8 }}>
                        <Tag tone="up">추천</Tag>
                      </div>
                    )}
                  </div>
                </td>
                <td
                  className="mono"
                  style={{ ...tdR(), color: T.up, fontWeight: 700, fontSize: 14 }}
                >
                  {fmtPct(p.apy, 2)}
                </td>
                <td style={tdR()}>{p.lock}</td>
                <td className="mono" style={tdR()}>
                  {p.min} {p.sym}
                </td>
                <td className="mono" style={tdR()}>
                  ₩{fmtNum(p.tvl / 1e8, 0)}억
                </td>
                <td style={{ ...tdR(), paddingRight: 14 }}>
                  <button
                    disabled
                    style={{
                      border: `1px solid ${T.border}`,
                      background: T.hover,
                      color: T.text3,
                      fontSize: 12,
                      fontWeight: 600,
                      padding: '6px 12px',
                      borderRadius: 6,
                      cursor: 'not-allowed',
                    }}
                  >
                    예치 (데모)
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
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
      스테이킹은 데모 화면입니다. 예치 기능은 구현되어 있지 않으며 표시된 APY/TVL은 예시 수치입니다.
    </div>
  );
}

function tdR(): React.CSSProperties {
  return {
    textAlign: 'right',
    padding: '14px',
    borderBottom: `1px solid ${T.borderSoft}`,
    fontSize: 12.5,
  };
}
