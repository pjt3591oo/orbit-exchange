import { useState } from 'react';
import { Link } from 'react-router-dom';
import { T } from '../design/tokens';

type Tone = 'up' | 'down' | 'brand' | 'ok' | 'warn' | 'neutral';

interface Alert {
  id: number;
  tone: Tone;
  cat: string;
  time: string;
  title: string;
  body: string;
  unread: boolean;
}

const ALERTS: Alert[] = [
  { id: 1, tone: 'up',      cat: '체결',   time: '2분 전',  title: 'BTC/KRW 매수 체결',         body: '0.06 BTC @ 50,000,000 KRW',        unread: true  },
  { id: 2, tone: 'brand',   cat: '가격',   time: '12분 전', title: 'ETH 5% 이상 상승',          body: '현재가 3,952,000 KRW 도달',         unread: true  },
  { id: 3, tone: 'warn',    cat: '예약',   time: '1시간 전', title: 'BTC 지정가 주문 미체결 알림', body: '24시간 경과, 주문 관리 필요',       unread: true  },
  { id: 4, tone: 'ok',      cat: '입금',   time: '3시간 전', title: '원화 입금 완료',            body: '+₩1,000,000 KRW',                   unread: false },
  { id: 5, tone: 'down',    cat: '체결',   time: '어제',    title: 'ETH/KRW 매도 체결',         body: '1.2 ETH @ 3,902,000 KRW',           unread: false },
  { id: 6, tone: 'neutral', cat: '시스템', time: '2일 전',  title: '새로운 기기에서 로그인',      body: 'macOS · Seoul, KR',                 unread: false },
];

const toneColor: Record<Tone, string> = {
  up: T.up, down: T.down, brand: T.brandInk, ok: T.ok, warn: T.warn, neutral: T.text3,
};
const toneBg: Record<Tone, string> = {
  up: T.upBg, down: T.downBg, brand: T.brandSoft, ok: T.okBg, warn: T.warnBg, neutral: T.hover,
};

export function AlertsDropdown({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const [readIds, setReadIds] = useState<Set<number>>(new Set());

  const visible = (tab === 'unread' ? ALERTS.filter((a) => a.unread && !readIds.has(a.id)) : ALERTS);
  const unreadCount = ALERTS.filter((a) => a.unread && !readIds.has(a.id)).length;

  const markAll = () => setReadIds(new Set(ALERTS.filter((a) => a.unread).map((a) => a.id)));
  const markOne = (id: number) => setReadIds((s) => new Set([...s, id]));

  return (
    <>
      {/* click-outside backdrop */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'transparent' }}
      />
      <div
        style={{
          position: 'absolute',
          top: 46,
          right: 12,
          width: 360,
          background: T.card,
          borderRadius: 10,
          zIndex: 61,
          boxShadow:
            '0 12px 40px rgba(14,17,22,0.18), 0 0 0 1px rgba(14,17,22,0.06)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 14px',
            borderBottom: `1px solid ${T.borderSoft}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>알림</span>
            {unreadCount > 0 && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: T.up,
                  background: T.upBg,
                  padding: '1px 7px',
                  borderRadius: 10,
                  whiteSpace: 'nowrap',
                }}
              >
                {unreadCount} 새 알림
              </span>
            )}
          </div>
          <button
            onClick={markAll}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 11,
              color: T.text3,
              padding: 0,
              whiteSpace: 'nowrap',
            }}
          >
            모두 읽음
          </button>
        </div>

        <div style={{ display: 'flex', gap: 4, padding: '8px 14px 0' }}>
          {(
            [
              { k: 'all', l: '전체' },
              { k: 'unread', l: '안 읽음' },
            ] as const
          ).map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              style={{
                border: 'none',
                background: tab === t.k ? T.text : 'transparent',
                color: tab === t.k ? '#fff' : T.text2,
                fontSize: 11.5,
                fontWeight: 600,
                padding: '5px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t.l}
            </button>
          ))}
        </div>

        <div style={{ maxHeight: 420, overflow: 'auto', padding: '8px 0' }}>
          {visible.length === 0 ? (
            <div
              style={{
                padding: '30px 14px',
                textAlign: 'center',
                color: T.text3,
                fontSize: 12,
              }}
            >
              새 알림이 없습니다
            </div>
          ) : (
            visible.map((a) => {
              const unread = a.unread && !readIds.has(a.id);
              return (
                <div
                  key={a.id}
                  onClick={() => markOne(a.id)}
                  style={{
                    display: 'flex',
                    gap: 10,
                    padding: '10px 14px',
                    cursor: 'pointer',
                    background: unread ? T.brandSoft + '40' : 'transparent',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = T.hover)}
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = unread ? T.brandSoft + '40' : 'transparent')
                  }
                >
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      flexShrink: 0,
                      background: toneBg[a.tone],
                      color: toneColor[a.tone],
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 800,
                      letterSpacing: 0.2,
                    }}
                  >
                    {a.cat.slice(0, 2)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: 700,
                          color: T.text,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {a.title}
                      </span>
                      <span
                        style={{
                          fontSize: 10.5,
                          color: T.text3,
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}
                      >
                        {a.time}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: T.text2,
                        marginTop: 2,
                        fontFamily: /\d/.test(a.body) ? 'var(--font-num)' : 'inherit',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {a.body}
                    </div>
                  </div>
                  {unread && (
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: T.brand,
                        alignSelf: 'center',
                        flexShrink: 0,
                      }}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>

        <div
          style={{
            padding: '10px 14px',
            borderTop: `1px solid ${T.borderSoft}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: T.bgAlt,
          }}
        >
          <span style={{ fontSize: 11, color: T.text3 }}>데모 알림</span>
          <Link
            to="/notices"
            onClick={onClose}
            style={{
              fontSize: 11,
              color: T.brandInk,
              fontWeight: 600,
              textDecoration: 'none',
              cursor: 'pointer',
            }}
          >
            전체 공지 ›
          </Link>
        </div>
      </div>
    </>
  );
}
