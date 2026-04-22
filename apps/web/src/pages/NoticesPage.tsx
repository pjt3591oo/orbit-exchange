import { useMemo, useState } from 'react';
import { T } from '../design/tokens';
import { Tag } from '../design/atoms';

type Category = '상장' | '점검' | '이벤트' | '안내';
interface Notice {
  id: number;
  cat: Category;
  pin: boolean;
  date: string;
  title: string;
  body: string;
}

const NOTICES: Notice[] = [
  {
    id: 1,
    cat: '상장',
    pin: true,
    date: '2026-04-22',
    title: '[신규상장] BTC/USDT 마켓 오픈',
    body: 'Bitcoin(BTC)의 USDT 마켓이 4월 23일 14:00에 오픈됩니다. 오픈 전 주문은 가능하며 체결은 오픈 시점 이후에 이뤄집니다. 초기 변동성이 크므로 지정가 주문을 권장합니다.',
  },
  {
    id: 2,
    cat: '점검',
    pin: true,
    date: '2026-04-21',
    title: '[정기점검] 4월 24일 새벽 03:00–05:00 서비스 일시 중단',
    body: '시스템 안정화를 위한 정기점검이 진행됩니다. 점검 시간 중 모든 주문/입출금/지갑 서비스가 일시 중단됩니다.',
  },
  {
    id: 3,
    cat: '이벤트',
    pin: false,
    date: '2026-04-20',
    title: '[이벤트] ETH 스테이킹 APY 2% 상향 (기간한정)',
    body: '4월 20일부터 5월 4일까지 2주간 ETH 스테이킹 APY가 기존 5.42%에서 7.42%로 상향 적용됩니다.',
  },
  {
    id: 4,
    cat: '안내',
    pin: false,
    date: '2026-04-19',
    title: '[안내] 투자자 보호 관련 약관 개정 안내',
    body: '전자금융거래법 개정에 따른 이용약관 개정사항을 안내드립니다. 변경일: 2026-05-01.',
  },
  {
    id: 5,
    cat: '이벤트',
    pin: false,
    date: '2026-04-15',
    title: '[이벤트] 신규 회원 대상 수수료 할인 30일',
    body: '가입일로부터 30일간 거래 수수료 50% 할인이 적용됩니다. 첫 원화 입금 시 5,000 KRW 캐시백도 함께 지급됩니다.',
  },
];

const CATEGORIES: Array<Category | '전체'> = ['전체', '상장', '점검', '이벤트', '안내'];

export function NoticesPage() {
  const [cat, setCat] = useState<Category | '전체'>('전체');
  const [openId, setOpenId] = useState<number | null>(null);

  const list = useMemo(
    () => NOTICES.filter((n) => cat === '전체' || n.cat === cat),
    [cat],
  );
  const opened = openId ? NOTICES.find((n) => n.id === openId) ?? null : null;

  return (
    <div style={{ padding: 'clamp(12px, 3vw, 24px)', maxWidth: 720, margin: '0 auto' }}>
      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '16px 20px 10px',
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            borderBottom: `1px solid ${T.borderSoft}`,
          }}
        >
          {CATEGORIES.map((c) => {
            const active = cat === c;
            return (
              <button
                key={c}
                onClick={() => setCat(c)}
                style={{
                  border: `1px solid ${active ? T.text : T.border}`,
                  background: active ? T.text : T.card,
                  color: active ? '#fff' : T.text2,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '6px 12px',
                  borderRadius: 20,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {c}
              </button>
            );
          })}
        </div>

        {!opened ? (
          <div>
            {list.map((n) => (
              <div
                key={n.id}
                onClick={() => setOpenId(n.id)}
                style={{
                  padding: '14px 20px',
                  borderTop: `1px solid ${T.borderSoft}`,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = T.hover)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ flexShrink: 0 }}>
                  {n.pin ? <Tag tone="up">고정</Tag> : <Tag tone="neutral">{n.cat}</Tag>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: T.text,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {n.title}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 11, color: T.text3, marginTop: 3 }}
                  >
                    {n.date}
                  </div>
                </div>
                <span style={{ color: T.text3, fontSize: 14 }}>›</span>
              </div>
            ))}
            {list.length === 0 && (
              <div
                style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 12 }}
              >
                해당 카테고리의 공지가 없습니다
              </div>
            )}
          </div>
        ) : (
          <div style={{ padding: 20 }}>
            <button
              onClick={() => setOpenId(null)}
              style={{
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 12,
                color: T.text3,
                padding: 0,
                marginBottom: 14,
              }}
            >
              ← 목록으로
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Tag tone="brand">{opened.cat}</Tag>
              <span className="mono" style={{ fontSize: 11, color: T.text3 }}>
                {opened.date}
              </span>
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: T.text,
                lineHeight: 1.4,
                marginBottom: 14,
              }}
            >
              {opened.title}
            </div>
            <div
              style={{
                fontSize: 13,
                color: T.text2,
                lineHeight: 1.7,
                paddingTop: 14,
                borderTop: `1px solid ${T.borderSoft}`,
              }}
            >
              {opened.body}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
