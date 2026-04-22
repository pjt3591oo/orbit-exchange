// mobile.jsx — ORBIT mobile trading view (iOS frame)
// Compact version: symbol header, mini chart, order book compact, order form, bottom nav.

function MobileApp({ T, market, candles, book }) {
  const [tab, setTab] = useState('trade');
  const [side, setSide] = useState('buy');
  const [mode, setMode] = useState('limit');
  const col = market.chg24 >= 0 ? T.up : T.down;

  return (
    <div style={{
      width: '100%', height: '100%', background: T.bg,
      display: 'flex', flexDirection: 'column', fontFamily: 'inherit',
      overflow: 'hidden',
    }}>
      {/* Top bar */}
      <div style={{
        background: T.card, borderBottom: `1px solid ${T.border}`,
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <button style={{ border: 'none', background: 'transparent',
          fontSize: 18, color: T.text, padding: 0, cursor: 'pointer' }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{market.sym}/KRW</span>
            <IconStar filled color="#E5A44A" size={13} />
          </div>
          <div style={{ fontSize: 10.5, color: T.text3 }}>{market.name}</div>
        </div>
        <button style={{
          width: 32, height: 32, border: `1px solid ${T.border}`,
          background: T.card, borderRadius: 8, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>⋯</button>
      </div>

      {tab === 'trade' && (
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          {/* Price head */}
          <div style={{
            padding: '14px 16px 12px', background: T.card,
            borderBottom: `1px solid ${T.borderSoft}`,
          }}>
            <div style={{
              fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
              fontSize: 28, fontWeight: 700, color: col, letterSpacing: -0.5, lineHeight: 1.1,
            }}>{fmtNum(market.price, 0)}</div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginTop: 4,
              fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
              fontSize: 12, fontWeight: 600,
            }}>
              <span style={{ color: col }}>{fmtPct(market.chg24)}</span>
              <span style={{ color: T.text3 }}>
                24h {fmtAbbr(market.vol24 / market.price)} {market.sym}
              </span>
            </div>
          </div>

          {/* Mini chart */}
          <div style={{ background: T.card, borderBottom: `1px solid ${T.border}`,
            padding: '6px 0 0' }}>
            <div style={{ display: 'flex', gap: 4, padding: '0 12px 6px' }}>
              {['1m','15m','1h','4h','1D'].map((t, i) => (
                <span key={t} style={{
                  fontSize: 11, padding: '4px 8px', borderRadius: 4, fontWeight: 600,
                  background: i === 2 ? T.text : 'transparent',
                  color: i === 2 ? '#fff' : T.text2,
                }}>{t}</span>
              ))}
            </div>
            <div style={{ height: 180 }}>
              <Chart candles={candles.slice(-40)} width={360} height={180}
                up={T.up} down={T.down} text3={T.text3} border={T.border} borderSoft={T.borderSoft} />
            </div>
          </div>

          {/* Compact order book */}
          <div style={{ background: T.card, padding: '10px 0',
            borderBottom: `1px solid ${T.border}` }}>
            <div style={{ padding: '0 16px 6px', fontSize: 12, fontWeight: 700, color: T.text }}>호가</div>
            <CompactBook T={T} book={book} />
          </div>

          {/* Quick action */}
          <div style={{ padding: 16, background: T.card, display: 'flex', gap: 8 }}>
            <button onClick={() => setSide('buy')} style={{
              flex: 1, background: T.up, color: '#fff', border: 'none',
              fontFamily: 'inherit', fontSize: 14, fontWeight: 700,
              padding: '14px 0', borderRadius: 8, cursor: 'pointer',
            }}>매수</button>
            <button onClick={() => setSide('sell')} style={{
              flex: 1, background: T.down, color: '#fff', border: 'none',
              fontFamily: 'inherit', fontSize: 14, fontWeight: 700,
              padding: '14px 0', borderRadius: 8, cursor: 'pointer',
            }}>매도</button>
          </div>

          {/* Order form summary */}
          <div style={{
            margin: '0 16px 16px', background: T.card,
            border: `1px solid ${T.border}`, borderRadius: 10, padding: 14,
          }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4,
              background: T.hover, borderRadius: 6, padding: 3, marginBottom: 12,
            }}>
              {[{k:'limit',l:'지정가'},{k:'market',l:'시장가'},{k:'stop',l:'예약'}].map(m => (
                <button key={m.k} onClick={() => setMode(m.k)} style={{
                  border: 'none',
                  background: mode === m.k ? T.card : 'transparent',
                  color: mode === m.k ? T.text : T.text2,
                  fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
                  padding: '6px 0', borderRadius: 4, cursor: 'pointer',
                }}>{m.l}</button>
              ))}
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 12, color: T.text3, padding: '4px 0',
            }}>
              <span>주문가능</span>
              <span style={{
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                color: T.text, fontWeight: 600,
              }}>₩8,420,100</span>
            </div>
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10.5, color: T.text3, fontWeight: 600, marginBottom: 4 }}>가격</div>
              <div style={{
                border: `1px solid ${T.border}`, borderRadius: 6,
                padding: '10px 12px', display: 'flex', alignItems: 'center',
              }}>
                <span style={{
                  flex: 1, fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                  fontSize: 14, color: T.text, fontWeight: 600,
                }}>{fmtNum(market.price, 0)}</span>
                <span style={{ color: T.text3, fontSize: 11, fontWeight: 600 }}>KRW</span>
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10.5, color: T.text3, fontWeight: 600, marginBottom: 4 }}>수량</div>
              <div style={{
                border: `1px solid ${T.border}`, borderRadius: 6,
                padding: '10px 12px', display: 'flex', alignItems: 'center',
              }}>
                <span style={{
                  flex: 1, fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                  fontSize: 14, color: T.text, fontWeight: 600,
                }}>0.0500</span>
                <span style={{ color: T.text3, fontSize: 11, fontWeight: 600 }}>{market.sym}</span>
              </div>
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4,
              marginTop: 8,
            }}>
              {[10,25,50,100].map((p, i) => (
                <button key={p} style={{
                  border: `1px solid ${T.border}`, background: i === 1 ? T.text : T.card,
                  color: i === 1 ? '#fff' : T.text2,
                  fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
                  padding: '7px 0', borderRadius: 4, cursor: 'pointer',
                }}>{p}%</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'home' && <MobileHome T={T} markets={MARKETS} />}
      {tab === 'holdings' && <MobileHoldings T={T} />}
      {tab === 'orders' && <MobileOrders T={T} />}
      {tab === 'more' && <MobileMore T={T} />}

      {/* Bottom nav */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
        borderTop: `1px solid ${T.border}`, background: T.card,
        paddingBottom: 20, flexShrink: 0,
      }}>
        {[
          { k: 'home', l: '홈', icon: '●' },
          { k: 'trade', l: '거래', icon: '◆' },
          { k: 'orders', l: '주문', icon: '≡' },
          { k: 'holdings', l: '자산', icon: '▮' },
          { k: 'more', l: '더보기', icon: '⋯' },
        ].map(t => {
          const active = tab === t.k;
          return (
            <button key={t.k} onClick={() => setTab(t.k)} style={{
              border: 'none', background: 'transparent', cursor: 'pointer',
              padding: '8px 0 4px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              color: active ? T.brand : T.text3,
              fontFamily: 'inherit',
            }}>
              <span style={{ fontSize: 14 }}>{t.icon}</span>
              <span style={{ fontSize: 10, fontWeight: 700 }}>{t.l}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CompactBook({ T, book }) {
  const { asks, bids } = book;
  const maxQty = Math.max(...asks.map(a => a.qty), ...bids.map(b => b.qty));
  const row = (r, side) => {
    const isAsk = side === 'ask';
    const color = isAsk ? T.up : T.down;
    const bg = isAsk ? T.upBg : T.downBg;
    const pct = (r.qty / maxQty) * 100;
    return (
      <div style={{ position: 'relative', height: 20, padding: '0 16px' }}>
        <div style={{
          position: 'absolute', top: 0, right: 16, bottom: 0,
          width: `calc(${pct}% - 0px)`, maxWidth: 'calc(100% - 32px)',
          background: bg,
        }} />
        <div style={{
          position: 'relative', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', height: '100%',
          fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
          fontSize: 11.5,
        }}>
          <span style={{ color, fontWeight: 600 }}>{fmtNum(r.price, 0)}</span>
          <span style={{ color: T.text }}>{r.qty.toFixed(3)}</span>
        </div>
      </div>
    );
  };
  return (
    <div>
      {asks.slice(-5).map((r, i) => <div key={'a'+i}>{row(r, 'ask')}</div>)}
      <div style={{
        padding: '6px 16px', borderTop: `1px solid ${T.borderSoft}`,
        borderBottom: `1px solid ${T.borderSoft}`, background: T.bgAlt,
        fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
        fontSize: 13, fontWeight: 700, color: T.up,
      }}>{fmtNum((asks[asks.length-1].price + bids[0].price) / 2, 0)}</div>
      {bids.slice(0, 5).map((r, i) => <div key={'b'+i}>{row(r, 'bid')}</div>)}
    </div>
  );
}

function MobileHome({ T, markets }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', background: T.card }}>
      <div style={{ padding: '14px 16px 10px', fontSize: 13, fontWeight: 700, color: T.text }}>
        원화 마켓
      </div>
      <div style={{ borderTop: `1px solid ${T.borderSoft}` }}>
        {markets.slice(0, 12).map(m => {
          const col = m.chg24 >= 0 ? T.up : T.down;
          return (
            <div key={m.sym} style={{
              display: 'grid', gridTemplateColumns: '1fr auto auto',
              gap: 10, alignItems: 'center', padding: '10px 16px',
              borderBottom: `1px solid ${T.borderSoft}`,
            }}>
              <div>
                <div style={{ fontSize: 13, color: T.text, fontWeight: 700 }}>{m.sym}/KRW</div>
                <div style={{ fontSize: 10.5, color: T.text3, marginTop: 1 }}>{m.name}</div>
              </div>
              <div style={{
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                fontSize: 13, color: T.text, fontWeight: 600, textAlign: 'right',
              }}>{fmtNum(m.price, m.price < 100 ? 2 : 0)}</div>
              <div style={{
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                fontSize: 12, color: col, fontWeight: 700, textAlign: 'right',
                minWidth: 62,
              }}>{fmtPct(m.chg24)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MobileHoldings({ T }) {
  const rows = HOLDINGS.map(h => {
    const m = MARKETS.find(x => x.sym === h.sym);
    return { ...h, name: m.name, cur: m.price, value: m.price * h.qty,
      cost: h.avg * h.qty };
  });
  const krw = 8_420_100;
  const total = rows.reduce((a, r) => a + r.value, 0) + krw;
  const cost = rows.reduce((a, r) => a + r.cost, 0) + krw;
  const pnl = total - cost;
  const col = pnl >= 0 ? T.up : T.down;
  return (
    <div style={{ flex: 1, overflow: 'auto', background: T.bg, padding: 16 }}>
      <div style={{
        background: T.card, borderRadius: 12, padding: 18,
        border: `1px solid ${T.border}`,
      }}>
        <div style={{ fontSize: 11, color: T.text3, fontWeight: 600 }}>총 평가자산</div>
        <div style={{
          marginTop: 6,
          fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
          fontSize: 28, fontWeight: 700, color: T.text, letterSpacing: -0.5,
        }}>{fmtKRW(total)}</div>
        <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
          <div>
            <div style={{ fontSize: 10.5, color: T.text3, fontWeight: 600 }}>평가손익</div>
            <div style={{
              fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
              fontSize: 14, color: col, fontWeight: 700,
            }}>{pnl >= 0 ? '+' : ''}{fmtNum(pnl, 0)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, color: T.text3, fontWeight: 600 }}>수익률</div>
            <div style={{
              fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
              fontSize: 14, color: col, fontWeight: 700,
            }}>{fmtPct((pnl / cost) * 100)}</div>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 16, background: T.card, borderRadius: 12,
        border: `1px solid ${T.border}`, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', fontSize: 12, fontWeight: 700, color: T.text,
          borderBottom: `1px solid ${T.borderSoft}` }}>보유 자산</div>
        {rows.map(r => {
          const p = ((r.value - r.cost) / r.cost) * 100;
          const c = p >= 0 ? T.up : T.down;
          return (
            <div key={r.sym} style={{
              display: 'grid', gridTemplateColumns: '1fr auto', gap: 8,
              padding: '10px 16px', borderBottom: `1px solid ${T.borderSoft}`,
              alignItems: 'center',
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{r.sym}</div>
                <div style={{
                  fontSize: 11, color: T.text3, marginTop: 1,
                  fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                }}>{r.qty} {r.sym}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{
                  fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                  fontSize: 13, color: T.text, fontWeight: 600,
                }}>{fmtKRW(r.value)}</div>
                <div style={{
                  fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                  fontSize: 11, color: c, fontWeight: 700, marginTop: 1,
                }}>{fmtPct(p)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MobileOrders({ T }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', background: T.card, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 10 }}>
        미체결 주문 · 2건
      </div>
      {[
        { mkt:'ASTR/KRW', side:'buy', price:47_900_000, qty:0.05, t:'14:22' },
        { mkt:'NOVA/KRW', side:'sell', price:695_000, qty:12, t:'13:58' },
      ].map((r, i) => (
        <div key={i} style={{
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: 10, padding: 14, marginBottom: 8,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{r.mkt}</span>
            <span style={{
              fontSize: 11, fontWeight: 700,
              color: r.side==='buy'?T.up:T.down,
              background: r.side==='buy'?T.upBg:T.downBg,
              padding: '2px 8px', borderRadius: 4,
            }}>{r.side==='buy'?'매수':'매도'} · 지정가</span>
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
            marginTop: 10, fontSize: 11,
          }}>
            <div>
              <div style={{ color: T.text3, fontWeight: 600 }}>가격</div>
              <div style={{
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                fontWeight: 600, color: T.text, marginTop: 2,
              }}>{fmtNum(r.price, 0)}</div>
            </div>
            <div>
              <div style={{ color: T.text3, fontWeight: 600 }}>수량</div>
              <div style={{
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                fontWeight: 600, color: T.text, marginTop: 2,
              }}>{r.qty}</div>
            </div>
            <div>
              <div style={{ color: T.text3, fontWeight: 600 }}>시각</div>
              <div style={{
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                fontWeight: 600, color: T.text, marginTop: 2,
              }}>{r.t}</div>
            </div>
          </div>
          <button style={{
            marginTop: 10, width: '100%', border: `1px solid ${T.border}`,
            background: T.card, color: T.text2,
            fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
            padding: '8px 0', borderRadius: 6, cursor: 'pointer',
          }}>주문 취소</button>
        </div>
      ))}
    </div>
  );
}

function MobileMore({ T }) {
  const items = [
    ['입출금', '₩8,420,100'],
    ['거래 내역', ''],
    ['보안 · 2FA', '활성'],
    ['수수료 등급', 'Tier 2 · 0.05%'],
    ['고객지원', ''],
    ['공지사항', 'NEW · 3'],
  ];
  return (
    <div style={{ flex: 1, overflow: 'auto', background: T.bg, padding: 16 }}>
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: 12, padding: 16, marginBottom: 12,
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: '50%',
          background: T.brand, color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 700,
        }}>JY</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>정윤호</div>
          <div style={{ fontSize: 11, color: T.text3 }}>jyunho@example.com</div>
        </div>
        <span style={{
          fontSize: 10.5, fontWeight: 700, color: T.ok, background: T.okBg,
          padding: '3px 8px', borderRadius: 4,
        }}>KYC 완료</span>
      </div>
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: 12, overflow: 'hidden',
      }}>
        {items.map(([k, v], i) => (
          <div key={k} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 16px',
            borderBottom: i < items.length-1 ? `1px solid ${T.borderSoft}` : 'none',
          }}>
            <span style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>{k}</span>
            <span style={{
              fontSize: 12, color: T.text3, fontWeight: 500,
              fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
            }}>{v} ›</span>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { MobileApp });
