// desktop.jsx — ORBIT Exchange, desktop trading view
// Layout:
//   [ top app bar ]
//   [ symbol summary strip                                               ]
//   [ market list | chart             | order book | order form         ]
//   [ bottom tabs: open orders / history / trades / assets               ]

const { useState, useMemo, useEffect } = React;

// ─────────────────────────────────────────────────────────────
// Atoms
// ─────────────────────────────────────────────────────────────
function Logo({ size = 20, color }) {
  // ORBIT — tilted ring monogram (original mark)
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block' }}>
      <ellipse cx="12" cy="12" rx="10" ry="5" fill="none" stroke={color} strokeWidth="1.8" transform="rotate(-28 12 12)" />
      <circle cx="12" cy="12" r="2.6" fill={color} />
    </svg>
  );
}

function Chip({ children, active, onClick, T, style }) {
  return (
    <button onClick={onClick} style={{
      border: 'none', background: active ? T.text : 'transparent',
      color: active ? '#fff' : T.text2,
      fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
      padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
      whiteSpace: 'nowrap',
      ...style,
    }}>{children}</button>
  );
}

function Tag({ children, tone = 'neutral', T }) {
  const map = {
    neutral: { bg: T.hover, fg: T.text2 },
    up: { bg: T.upBg, fg: T.up },
    down: { bg: T.downBg, fg: T.down },
    brand: { bg: T.brandSoft, fg: T.brandInk },
    warn: { bg: T.warnBg, fg: T.warn },
    ok: { bg: T.okBg, fg: T.ok },
  };
  const c = map[tone];
  return (
    <span style={{
      background: c.bg, color: c.fg,
      fontSize: 10.5, fontWeight: 700, padding: '2px 6px',
      borderRadius: 4, letterSpacing: 0.2, textTransform: 'uppercase',
      fontFamily: 'inherit', whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function IconSearch({ size = 14, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke={color} strokeWidth="1.4" />
      <path d="M10.5 10.5L13.5 13.5" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function IconStar({ filled, size = 12, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12">
      <path d="M6 1.2l1.55 3.14 3.47.5-2.51 2.45.59 3.45L6 9.1l-3.1 1.64.59-3.45L.98 4.84l3.47-.5L6 1.2z"
            fill={filled ? color : 'none'} stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
function IconBell({ size = 14, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M4 7a4 4 0 018 0v3l1 2H3l1-2V7z" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6.5 13.5a1.5 1.5 0 003 0" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────
// Top app bar
// ─────────────────────────────────────────────────────────────
function TopBar({ T, onOpenLogin, onOpenPortfolio, onOpenDeposit, onOpenStaking, onOpenNotices, loggedIn }) {
  const tabs = ['거래소', '포트폴리오', '입출금', '스테이킹', '공지'];
  const [active, setActive] = useState('거래소');
  const [bellOpen, setBellOpen] = useState(false);
  const onClick = (t) => {
    setActive(t);
    if (t === '포트폴리오') onOpenPortfolio();
    if (t === '입출금') onOpenDeposit();
    if (t === '스테이킹') onOpenStaking();
    if (t === '공지') onOpenNotices();
  };
  return (
    <div style={{
      height: 52, display: 'flex', alignItems: 'center',
      padding: '0 20px', borderBottom: `1px solid ${T.border}`,
      background: T.card, gap: 32, flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Logo size={22} color={T.brand} />
        <span style={{ fontWeight: 800, fontSize: 15, letterSpacing: 0.5, color: T.text }}>ORBIT</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: T.text3, letterSpacing: 1, marginLeft: 2 }}>EXCHANGE</span>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {tabs.map(t => (
          <button key={t} onClick={() => onClick(t)} style={{
            border: 'none', background: 'transparent',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            color: t === active ? T.text : T.text2,
            padding: '6px 10px', cursor: 'pointer',
            whiteSpace: 'nowrap',
            borderBottom: t === active ? `2px solid ${T.brand}` : '2px solid transparent',
            marginBottom: -2,
          }}>{t}</button>
        ))}
      </div>
      <div style={{
        marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8,
        background: T.hover, borderRadius: 8, padding: '6px 10px',
        width: 220, color: T.text3, fontSize: 12.5,
      }}>
        <IconSearch size={14} color={T.text3} />
        <span>심볼 검색…</span>
        <span style={{
          marginLeft: 'auto', fontSize: 10, fontWeight: 700,
          background: T.card, color: T.text2, padding: '2px 5px',
          borderRadius: 3, border: `1px solid ${T.border}`,
        }}>⌘K</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => setBellOpen(v => !v)} style={{ ...iconBtn(T), position: 'relative' }}>
          <IconBell color={T.text2} />
          <span style={{
            position: 'absolute', top: 4, right: 4, width: 7, height: 7,
            borderRadius: '50%', background: T.up,
            boxShadow: `0 0 0 1.5px ${T.card}`,
          }} />
        </button>
        {bellOpen && <AlertsDropdown T={T} onClose={() => setBellOpen(false)} />}
        {loggedIn ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: T.brand, color: '#fff', fontWeight: 700,
              fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>JY</div>
            <div style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>정윤호</div>
          </div>
        ) : (
          <button onClick={onOpenLogin} style={{
            background: T.text, color: '#fff', border: 'none',
            fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700,
            padding: '7px 14px', borderRadius: 6, cursor: 'pointer',
          }}>로그인</button>
        )}
      </div>
    </div>
  );
}

function iconBtn(T) {
  return {
    width: 30, height: 30, border: `1px solid ${T.border}`,
    background: T.card, borderRadius: 6, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}

function AlertsDropdown({ T, onClose }) {
  const [tab, setTab] = useState('all');
  const alerts = [
    { id: 1, tone: 'up',     cat: '체결',   time: '2분 전',  title: 'ASTR/KRW 매수 체결',     body: '0.05 ASTR @ 48,180,000 KRW', unread: true },
    { id: 2, tone: 'brand',  cat: '가격',   time: '12분 전', title: 'NOVA 5% 이상 상승',           body: '현재가 695,000 KRW 도달',  unread: true },
    { id: 3, tone: 'warn',   cat: '예약',   time: '1시간 전', title: 'LUMI 지정가 주문 미체결 알림', body: '24시간 경과, 주문 관리 필요', unread: true },
    { id: 4, tone: 'ok',     cat: '입금',   time: '3시간 전', title: '원화 입금 완료',            body: '+₩1,000,000 KRW',              unread: false },
    { id: 5, tone: 'down',   cat: '체결',   time: '어제',       title: 'HALO/KRW 매도 체결',     body: '540 HALO @ 8,930 KRW',         unread: false },
    { id: 6, tone: 'neutral',cat: '시스템', time: '2일 전',   title: '새로운 기기에서 로그인',       body: 'macOS · Seoul, KR',           unread: false },
  ];
  const visible = tab === 'unread' ? alerts.filter(a => a.unread) : alerts;
  const unreadCount = alerts.filter(a => a.unread).length;
  const toneColor = (t) => ({ up: T.up, down: T.down, brand: T.brandInk, ok: T.ok, warn: T.warn, neutral: T.text3 }[t]);
  const toneBg = (t) => ({ up: T.upBg, down: T.downBg, brand: T.brandSoft, ok: T.okBg, warn: T.warnBg, neutral: T.hover }[t]);
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
      <div style={{
        position: 'absolute', top: 46, right: 12, width: 360,
        background: T.card, borderRadius: 10, zIndex: 61,
        boxShadow: '0 12px 40px rgba(14,17,22,0.18), 0 0 0 1px rgba(14,17,22,0.06)',
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 14px', borderBottom: `1px solid ${T.borderSoft}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>알림</span>
            {unreadCount > 0 && (
              <span style={{
                fontSize: 10, fontWeight: 700, color: T.up, background: T.upBg,
                padding: '1px 7px', borderRadius: 10, whiteSpace: 'nowrap',
              }}>{unreadCount} 새 알림</span>
            )}
          </div>
          <button style={{
            border: 'none', background: 'transparent', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 11, color: T.text3, padding: 0,
            whiteSpace: 'nowrap',
          }}>모두 읽음</button>
        </div>
        <div style={{ display: 'flex', gap: 4, padding: '8px 14px 0' }}>
          {[['all','전체'],['unread','안 읽음']].map(([k,l]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              border: 'none',
              background: tab === k ? T.text : 'transparent',
              color: tab === k ? '#fff' : T.text2,
              fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
              padding: '5px 10px', borderRadius: 4, cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}>{l}</button>
          ))}
        </div>
        <div style={{ maxHeight: 420, overflow: 'auto', padding: '8px 0' }}>
          {visible.length === 0 && (
            <div style={{ padding: '30px 14px', textAlign: 'center', color: T.text3, fontSize: 12 }}>
              새 알림이 없습니다
            </div>
          )}
          {visible.map(a => (
            <div key={a.id} style={{
              display: 'flex', gap: 10, padding: '10px 14px',
              cursor: 'pointer', position: 'relative',
              background: a.unread ? T.brandSoft + '40' : 'transparent',
            }}
              onMouseEnter={e => e.currentTarget.style.background = T.hover}
              onMouseLeave={e => e.currentTarget.style.background = a.unread ? T.brandSoft + '40' : 'transparent'}
            >
              <div style={{
                width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                background: toneBg(a.tone), color: toneColor(a.tone),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 800, letterSpacing: 0.2,
              }}>{a.cat.slice(0,2)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8,
                }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.title}
                  </span>
                  <span style={{ fontSize: 10.5, color: T.text3, whiteSpace: 'nowrap', flexShrink: 0 }}>{a.time}</span>
                </div>
                <div style={{
                  fontSize: 11.5, color: T.text2, marginTop: 2,
                  fontFamily: /\d/.test(a.body) ? 'var(--font-num)' : 'inherit',
                  fontVariantNumeric: 'tabular-nums',
                }}>{a.body}</div>
              </div>
              {a.unread && (
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', background: T.brand,
                  alignSelf: 'center', flexShrink: 0,
                }} />
              )}
            </div>
          ))}
        </div>
        <div style={{
          padding: '10px 14px', borderTop: `1px solid ${T.borderSoft}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: T.bgAlt,
        }}>
          <span style={{ fontSize: 11, color: T.text3 }}>알림 설정</span>
          <span style={{ fontSize: 11, color: T.brandInk, fontWeight: 600, cursor: 'pointer' }}>전체 보기 ›</span>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Symbol summary strip (above chart)
// ─────────────────────────────────────────────────────────────
function SymbolStrip({ T, market, high24, low24, volKRW }) {
  const up = market.chg24 >= 0;
  const col = up ? T.up : T.down;
  const stats = [
    { label: '24h 고가', value: fmtNum(high24, 0) },
    { label: '24h 저가', value: fmtNum(low24, 0) },
    { label: '24h 거래량', value: (market.vol24 / market.price).toFixed(2) + ' ' + market.sym },
    { label: '24h 거래대금', value: '₩' + fmtAbbr(volKRW) },
  ];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 24,
      padding: '12px 20px', borderBottom: `1px solid ${T.border}`,
      background: T.card, flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: T.brandSoft, color: T.brandInk, fontWeight: 800,
          fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
          letterSpacing: 0.3,
        }}>{market.sym}</div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{market.sym}/KRW</span>
            <Tag tone="brand" T={T}>원화</Tag>
          </div>
          <div style={{ fontSize: 11.5, color: T.text3, marginTop: 2 }}>{market.name}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{
          fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
          fontSize: 26, fontWeight: 700, color: col, letterSpacing: -0.5,
        }}>{fmtNum(market.price, 0)}</span>
        <span style={{
          fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
          fontSize: 13, fontWeight: 600, color: col,
        }}>{fmtPct(market.chg24)}</span>
      </div>
      <div style={{ display: 'flex', gap: 24, marginLeft: 8 }}>
        {stats.map(s => (
          <div key={s.label} style={{ whiteSpace: 'nowrap' }}>
            <div style={{ fontSize: 10.5, color: T.text3, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>{s.label}</div>
            <div style={{
              fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
              fontSize: 12.5, fontWeight: 600, color: T.text, marginTop: 2, whiteSpace: 'nowrap',
            }}>{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Sidebar market list
// ─────────────────────────────────────────────────────────────
function MarketList({ T, markets, selected, onSelect, density }) {
  const [tab, setTab] = useState('KRW');
  const [q, setQ] = useState('');
  const rowH = density === 'compact' ? 30 : 38;

  const visible = useMemo(() => {
    let list = markets;
    if (tab === '관심') list = list.filter(m => m.favorite);
    if (q) list = list.filter(m => (m.sym + m.name).toLowerCase().includes(q.toLowerCase()));
    return list;
  }, [markets, tab, q]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.card }}>
      <div style={{ display: 'flex', gap: 2, padding: '10px 12px 6px', borderBottom: `1px solid ${T.borderSoft}` }}>
        {['관심','KRW','BTC','USDT'].map(t => (
          <Chip key={t} T={T} active={tab === t} onClick={() => setTab(t)}>{t}</Chip>
        ))}
      </div>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${T.borderSoft}` }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: T.bg, borderRadius: 6, padding: '6px 8px',
        }}>
          <IconSearch size={12} color={T.text3} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="종목 검색" style={{
            flex: 1, border: 'none', background: 'transparent', outline: 'none',
            fontFamily: 'inherit', fontSize: 12, color: T.text,
          }} />
        </div>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '16px 1fr 86px 68px',
        gap: 8, padding: '6px 12px',
        fontSize: 10.5, color: T.text3, fontWeight: 600,
        borderBottom: `1px solid ${T.borderSoft}`, letterSpacing: 0.2,
      }}>
        <span></span>
        <span>종목</span>
        <span style={{ textAlign: 'right' }}>현재가</span>
        <span style={{ textAlign: 'right' }}>24h</span>
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>
        {visible.map((m, i) => {
          const col = m.chg24 >= 0 ? T.up : T.down;
          const active = m.sym === selected;
          return (
            <div key={m.sym} onClick={() => onSelect(m.sym)} style={{
              display: 'grid',
              gridTemplateColumns: '16px 1fr 86px 68px',
              gap: 8, alignItems: 'center',
              height: rowH, padding: '0 12px',
              cursor: 'pointer',
              background: active ? T.brandSoft : 'transparent',
              borderLeft: active ? `2px solid ${T.brand}` : '2px solid transparent',
              paddingLeft: active ? 10 : 12,
              fontSize: 12,
            }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = T.hover; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
            >
              <IconStar filled={m.favorite} color={m.favorite ? '#E5A44A' : T.text4} />
              <div style={{ overflow: 'hidden' }}>
                <div style={{ color: T.text, fontWeight: 600, lineHeight: 1.1 }}>{m.sym}</div>
                <div style={{ color: T.text3, fontSize: 10.5, lineHeight: 1.2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
              </div>
              <div style={{
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                textAlign: 'right', color: T.text, fontWeight: 500,
              }}>{fmtNum(m.price, m.price < 100 ? 2 : 0)}</div>
              <div style={{
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                textAlign: 'right', color: col, fontWeight: 600, fontSize: 11.5,
              }}>{fmtPct(m.chg24)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Chart panel
// ─────────────────────────────────────────────────────────────
function ChartPanel({ T, market, candles }) {
  const [tf, setTf] = useState('15m');
  const [type, setType] = useState('candle');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.card }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '8px 12px', borderBottom: `1px solid ${T.borderSoft}`,
      }}>
        {['1m','5m','15m','1h','4h','1D','1W'].map(t => (
          <Chip key={t} T={T} active={t === tf} onClick={() => setTf(t)} style={{ padding: '4px 8px', fontSize: 11.5 }}>{t}</Chip>
        ))}
        <div style={{ width: 1, height: 16, background: T.border, margin: '0 6px' }} />
        {['candle','line'].map(t => (
          <Chip key={t} T={T} active={t === type} onClick={() => setType(t)} style={{ padding: '4px 8px', fontSize: 11.5 }}>
            {t === 'candle' ? '캔들' : '라인'}
          </Chip>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', color: T.text3, fontSize: 11 }}>
          <span>지표</span>
          <Tag tone="neutral" T={T}>MA</Tag>
          <Tag tone="neutral" T={T}>Vol</Tag>
          <button style={{
            border: `1px solid ${T.border}`, background: T.card,
            fontFamily: 'inherit', fontSize: 11, color: T.text2,
            padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
            whiteSpace: 'nowrap', flexShrink: 0,
          }}>+ 지표</button>
        </div>
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        <ChartAutoSize T={T} candles={candles} />
      </div>
    </div>
  );
}

function ChartAutoSize({ T, candles }) {
  const ref = React.useRef(null);
  const [size, setSize] = React.useState({ w: 760, h: 360 });
  React.useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(400, r.width), h: Math.max(240, r.height) });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0 }}>
      <Chart candles={candles} width={size.w} height={size.h}
        up={T.up} down={T.down} text3={T.text3} border={T.border} borderSoft={T.borderSoft} />
    </div>
  );
}

Object.assign(window, { Logo, Chip, Tag, TopBar, SymbolStrip, MarketList, ChartPanel, AlertsDropdown });
