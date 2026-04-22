// orderbook.jsx — Order book, trade tape, order form, bottom tabs
// Uses window globals from tokens.jsx, chart.jsx, desktop.jsx.

// ─────────────────────────────────────────────────────────────
// Order book
// ─────────────────────────────────────────────────────────────
function OrderBook({ T, book, mid, onPickPrice, layout = 'vertical' }) {
  const { asks, bids } = book;
  const maxQty = Math.max(...asks.map(a => a.qty), ...bids.map(b => b.qty));

  const Row = ({ side, r }) => {
    const isAsk = side === 'ask';
    const col = isAsk ? T.up : T.down;
    const bg = isAsk ? T.upBg : T.downBg;
    const pct = (r.qty / maxQty) * 100;
    return (
      <div onClick={() => onPickPrice(r.price)} style={{
        position: 'relative', height: 20, cursor: 'pointer',
        fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
        fontSize: 11.5,
      }}>
        <div style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: `${pct}%`,
          background: bg, pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', inset: 0, display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr', alignItems: 'center',
          padding: '0 10px',
        }}>
          <span style={{ color: col, fontWeight: 600 }}>{fmtNum(r.price, 0)}</span>
          <span style={{ color: T.text, textAlign: 'right' }}>{r.qty.toFixed(4)}</span>
          <span style={{ color: T.text3, textAlign: 'right' }}>{fmtNum(r.price * r.qty, 0)}</span>
        </div>
      </div>
    );
  };

  const Header = () => (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
      padding: '6px 10px', fontSize: 10, color: T.text3,
      fontWeight: 600, letterSpacing: 0.3,
      borderBottom: `1px solid ${T.borderSoft}`,
    }}>
      <span>가격(KRW)</span>
      <span style={{ textAlign: 'right' }}>수량</span>
      <span style={{ textAlign: 'right' }}>합계</span>
    </div>
  );

  const Mid = () => (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 10px', borderTop: `1px solid ${T.borderSoft}`,
      borderBottom: `1px solid ${T.borderSoft}`, background: T.bgAlt,
    }}>
      <span style={{
        fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
        fontSize: 15, fontWeight: 700, color: T.up,
      }}>{fmtNum(mid, 0)}</span>
      <span style={{ fontSize: 10.5, color: T.text3 }}>≈ ₩{fmtNum(mid, 0)}</span>
    </div>
  );

  if (layout === 'horizontal') {
    // bids left | asks right
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.card }}>
        <div style={{ padding: '8px 12px', borderBottom: `1px solid ${T.borderSoft}`,
          fontSize: 12, fontWeight: 700, color: T.text }}>호가</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', flex: 1, minHeight: 0 }}>
          <div style={{ borderRight: `1px solid ${T.borderSoft}`, overflow: 'hidden' }}>
            <Header />
            <div style={{ overflow: 'auto', height: 'calc(100% - 28px)' }}>
              {bids.map((r, i) => <Row key={i} side="bid" r={r} />)}
            </div>
          </div>
          <div style={{ overflow: 'hidden' }}>
            <Header />
            <div style={{ overflow: 'auto', height: 'calc(100% - 28px)' }}>
              {asks.slice().reverse().map((r, i) => <Row key={i} side="ask" r={r} />)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // vertical (default): asks top → mid → bids bottom
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.card }}>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${T.borderSoft}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>호가</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <Chip T={T} style={{ padding: '3px 6px', fontSize: 10.5 }}>0.01</Chip>
          <Chip T={T} active style={{ padding: '3px 6px', fontSize: 10.5 }}>1</Chip>
        </div>
      </div>
      <Header />
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div>
          {asks.map((r, i) => <Row key={'a' + i} side="ask" r={r} />)}
        </div>
        <Mid />
        <div>
          {bids.map((r, i) => <Row key={'b' + i} side="bid" r={r} />)}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Order form (limit / market)
// ─────────────────────────────────────────────────────────────
function OrderForm({ T, market, pickedPrice }) {
  const [side, setSide] = useState('buy');
  const [mode, setMode] = useState('limit');
  const [price, setPrice] = useState(market.price);
  const [qty, setQty] = useState(0);
  const [pctPick, setPctPick] = useState(0);
  const [toast, setToast] = useState(null);
  const krwBalance = 8_420_100;
  const coinBalance = 0.4821;

  useEffect(() => {
    if (pickedPrice) setPrice(pickedPrice);
  }, [pickedPrice]);

  useEffect(() => { setPrice(market.price); }, [market.sym]);

  const total = mode === 'market' ? qty * market.price : price * qty;
  const avail = side === 'buy' ? krwBalance : coinBalance;

  const onPct = (p) => {
    setPctPick(p);
    if (side === 'buy') {
      const amt = krwBalance * p / 100;
      setQty(+(amt / price).toFixed(4));
    } else {
      setQty(+(coinBalance * p / 100).toFixed(4));
    }
  };

  const submit = () => {
    setToast({
      text: `${side === 'buy' ? '매수' : '매도'} 주문 접수됨 · ${qty.toFixed(4)} ${market.sym} @ ${fmtNum(price, 0)}`,
      tone: side === 'buy' ? 'up' : 'down',
    });
    setTimeout(() => setToast(null), 2800);
  };

  const actionCol = side === 'buy' ? T.up : T.down;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.card, position: 'relative' }}>
      {/* side tabs */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: `1px solid ${T.border}` }}>
        <button onClick={() => setSide('buy')} style={sideTab(T, side === 'buy', T.up)}>매수</button>
        <button onClick={() => setSide('sell')} style={sideTab(T, side === 'sell', T.down)}>매도</button>
      </div>

      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        {/* mode */}
        <div style={{ display: 'flex', gap: 4 }}>
          {[{k:'limit',l:'지정가'},{k:'market',l:'시장가'},{k:'stop',l:'예약'}].map(m => (
            <Chip key={m.k} T={T} active={mode === m.k} onClick={() => setMode(m.k)}
              style={{ padding: '5px 10px', fontSize: 11.5 }}>{m.l}</Chip>
          ))}
        </div>

        <FieldRow T={T} label="주문가능">
          <span style={{
            fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
            fontSize: 12, color: T.text, fontWeight: 600,
          }}>
            {side === 'buy' ? `₩${fmtNum(krwBalance, 0)}` : `${coinBalance.toFixed(4)} ${market.sym}`}
          </span>
        </FieldRow>

        <NumField T={T} label="가격 (KRW)" value={price} onChange={setPrice}
          disabled={mode === 'market'} suffix="KRW" />

        <NumField T={T} label="수량" value={qty} onChange={setQty} suffix={market.sym} digits={4} />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4 }}>
          {[10,25,50,100].map(p => (
            <button key={p} onClick={() => onPct(p)} style={{
              border: `1px solid ${pctPick === p ? T.text : T.border}`,
              background: pctPick === p ? T.text : T.card,
              color: pctPick === p ? '#fff' : T.text2,
              fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
              padding: '5px 0', borderRadius: 4, cursor: 'pointer',
            }}>{p}%</button>
          ))}
        </div>

        <FieldRow T={T} label="주문총액">
          <span style={{
            fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
            fontSize: 13, color: T.text, fontWeight: 700,
          }}>₩ {fmtNum(total, 0)}</span>
        </FieldRow>

        <div style={{
          background: T.bgAlt, border: `1px solid ${T.borderSoft}`, borderRadius: 6,
          padding: '8px 10px', fontSize: 10.5, color: T.text3, lineHeight: 1.5,
          marginTop: 'auto',
        }}>
          수수료 0.05% · 최소주문금액 5,000 KRW<br />
          가상 계정이며 실제 주문이 아닙니다.
        </div>

        <button onClick={submit} style={{
          background: actionCol, color: '#fff', border: 'none',
          fontFamily: 'inherit', fontSize: 14, fontWeight: 700,
          padding: '12px 0', borderRadius: 6, cursor: 'pointer',
          letterSpacing: 0.5,
        }}>
          {side === 'buy' ? '매수' : '매도'} · {market.sym}
        </button>
      </div>

      {toast && (
        <div style={{
          position: 'absolute', left: 12, right: 12, bottom: 12,
          background: T.text, color: '#fff', borderRadius: 6,
          padding: '10px 12px', fontSize: 12, fontWeight: 500,
          display: 'flex', alignItems: 'center', gap: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: toast.tone === 'up' ? T.up : T.down,
          }} />
          {toast.text}
        </div>
      )}
    </div>
  );
}

function sideTab(T, active, col) {
  return {
    border: 'none', background: active ? col : 'transparent',
    color: active ? '#fff' : T.text2,
    fontFamily: 'inherit', fontSize: 13, fontWeight: 700,
    padding: '10px 0', cursor: 'pointer',
    borderBottom: active ? `2px solid ${col}` : '2px solid transparent',
  };
}

function FieldRow({ T, label, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 0', fontSize: 11.5, color: T.text3, gap: 8,
    }}>
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ whiteSpace: 'nowrap' }}>{children}</span>
    </div>
  );
}

function NumField({ T, label, value, onChange, disabled, suffix, digits = 0 }) {
  const str = typeof value === 'number' ? value.toLocaleString('en-US', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }) : value;
  const step = () => {
    if (!onChange) return;
    onChange(+(Number(value) + 1).toFixed(digits));
  };
  return (
    <div>
      <div style={{ fontSize: 10.5, color: T.text3, marginBottom: 4, fontWeight: 600 }}>{label}</div>
      <div style={{
        display: 'flex', alignItems: 'center',
        border: `1px solid ${T.border}`, borderRadius: 6,
        background: disabled ? T.bg : T.card,
        opacity: disabled ? 0.6 : 1,
      }}>
        <input
          value={disabled ? '시장가' : str}
          onChange={e => onChange(+e.target.value.replace(/[^\d.]/g, '') || 0)}
          disabled={disabled}
          style={{
            flex: 1, border: 'none', outline: 'none', background: 'transparent',
            fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
            fontSize: 13, color: T.text, padding: '8px 10px', fontWeight: 500,
          }}
        />
        <span style={{ fontSize: 11, color: T.text3, padding: '0 10px', fontWeight: 600 }}>{suffix}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Trade tape (recent trades)
// ─────────────────────────────────────────────────────────────
function TradeTape({ T, trades }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.card }}>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${T.borderSoft}`,
        fontSize: 12, fontWeight: 700, color: T.text }}>체결</div>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 68px',
        padding: '6px 12px', fontSize: 10, color: T.text3,
        fontWeight: 600, borderBottom: `1px solid ${T.borderSoft}`,
      }}>
        <span>가격</span>
        <span style={{ textAlign: 'right' }}>수량</span>
        <span style={{ textAlign: 'right' }}>시간</span>
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>
        {trades.map((t, i) => {
          const col = t.side === 'buy' ? T.up : T.down;
          const d = new Date(t.t);
          const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
          return (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr 68px',
              padding: '4px 12px', fontSize: 11.5,
              fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
            }}>
              <span style={{ color: col, fontWeight: 600 }}>{fmtNum(t.price, 0)}</span>
              <span style={{ color: T.text, textAlign: 'right' }}>{t.qty.toFixed(4)}</span>
              <span style={{ color: T.text3, textAlign: 'right' }}>{time}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Bottom tabs: open orders / order history / trade history / assets
// ─────────────────────────────────────────────────────────────
function BottomTabs({ T, holdings, markets }) {
  const [tab, setTab] = useState('open');
  const tabs = [
    { k: 'open',    l: '미체결 (2)' },
    { k: 'orderH',  l: '주문 내역' },
    { k: 'tradeH',  l: '체결 내역' },
    { k: 'assets',  l: '자산' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.card }}>
      <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${T.border}`, padding: '0 8px' }}>
        {tabs.map(t => (
          <button key={t.k} onClick={() => setTab(t.k)} style={{
            border: 'none', background: 'transparent',
            fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
            color: tab === t.k ? T.text : T.text3,
            padding: '10px 14px', cursor: 'pointer',
            whiteSpace: 'nowrap',
            borderBottom: tab === t.k ? `2px solid ${T.brand}` : '2px solid transparent',
            marginBottom: -1,
          }}>{t.l}</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, paddingRight: 8 }}>
          <label style={{ fontSize: 11, color: T.text3, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" style={{ accentColor: T.brand }} /> 현재 종목만
          </label>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'open' && <OpenOrdersTable T={T} />}
        {tab === 'orderH' && <OrderHistoryTable T={T} />}
        {tab === 'tradeH' && <TradeHistoryTable T={T} />}
        {tab === 'assets' && <AssetsTable T={T} holdings={holdings} markets={markets} />}
      </div>
    </div>
  );
}

function Th({ T, children, align }) {
  return <th style={{
    textAlign: align || 'left', fontWeight: 600, fontSize: 11,
    color: T.text3, padding: '10px 14px', borderBottom: `1px solid ${T.borderSoft}`,
    letterSpacing: 0.2, background: T.bgAlt, position: 'sticky', top: 0,
  }}>{children}</th>;
}
function Td({ T, children, align, mono, color, weight }) {
  return <td style={{
    textAlign: align || 'left',
    fontFamily: mono ? 'var(--font-num)' : 'inherit',
    fontVariantNumeric: mono ? 'tabular-nums' : 'normal',
    fontSize: 12, color: color || T.text, fontWeight: weight || 400,
    padding: '9px 14px', borderBottom: `1px solid ${T.borderSoft}`,
  }}>{children}</td>;
}

function OpenOrdersTable({ T }) {
  const rows = [
    { t:'14:22:08', mkt:'ASTR/KRW', type:'지정가', side:'buy',  price:47_900_000, qty:0.05, filled:0, total:2_395_000 },
    { t:'13:58:41', mkt:'NOVA/KRW', type:'지정가', side:'sell', price:   695_000, qty:12,   filled:0, total:8_340_000 },
  ];
  return (
    <table style={tableStyle}>
      <thead><tr>
        <Th T={T}>주문시각</Th><Th T={T}>마켓</Th><Th T={T}>타입</Th>
        <Th T={T}>구분</Th><Th T={T} align="right">가격</Th><Th T={T} align="right">수량</Th>
        <Th T={T} align="right">체결량</Th><Th T={T} align="right">총액</Th><Th T={T} align="right">액션</Th>
      </tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <Td T={T} mono>{r.t}</Td>
            <Td T={T} weight={600}>{r.mkt}</Td>
            <Td T={T}>{r.type}</Td>
            <Td T={T} color={r.side==='buy'?T.up:T.down} weight={700}>{r.side==='buy'?'매수':'매도'}</Td>
            <Td T={T} mono align="right">{fmtNum(r.price,0)}</Td>
            <Td T={T} mono align="right">{r.qty}</Td>
            <Td T={T} mono align="right" color={T.text3}>{r.filled}</Td>
            <Td T={T} mono align="right" weight={600}>{fmtNum(r.total,0)}</Td>
            <Td T={T} align="right">
              <button style={{
                border: `1px solid ${T.border}`, background: T.card,
                fontFamily: 'inherit', fontSize: 11, color: T.text2,
                padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
              }}>취소</button>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OrderHistoryTable({ T }) {
  const rows = [
    { t:'04-22 13:02', mkt:'ASTR/KRW', type:'지정가', side:'buy',  price:47_120_000, qty:0.08, state:'체결', total:3_769_600 },
    { t:'04-22 11:47', mkt:'LUMI/KRW', type:'시장가', side:'sell', price: 3_828_000, qty:3.2,  state:'체결', total:12_249_600 },
    { t:'04-21 22:10', mkt:'HALO/KRW', type:'지정가', side:'buy',  price:     8_820, qty:1200, state:'취소', total:10_584_000 },
    { t:'04-21 18:31', mkt:'KRON/KRW', type:'지정가', side:'buy',  price:   418_000, qty:12,   state:'체결', total:5_016_000 },
    { t:'04-21 09:04', mkt:'NOVA/KRW', type:'지정가', side:'buy',  price:   642_000, qty:22,   state:'체결', total:14_124_000 },
  ];
  return (
    <table style={tableStyle}>
      <thead><tr>
        <Th T={T}>시각</Th><Th T={T}>마켓</Th><Th T={T}>타입</Th>
        <Th T={T}>구분</Th><Th T={T} align="right">가격</Th><Th T={T} align="right">수량</Th>
        <Th T={T}>상태</Th><Th T={T} align="right">총액</Th>
      </tr></thead>
      <tbody>
        {rows.map((r,i) => (
          <tr key={i}>
            <Td T={T} mono>{r.t}</Td>
            <Td T={T} weight={600}>{r.mkt}</Td>
            <Td T={T}>{r.type}</Td>
            <Td T={T} color={r.side==='buy'?T.up:T.down} weight={700}>{r.side==='buy'?'매수':'매도'}</Td>
            <Td T={T} mono align="right">{fmtNum(r.price,0)}</Td>
            <Td T={T} mono align="right">{r.qty}</Td>
            <Td T={T}>
              <Tag tone={r.state==='체결'?'ok':'neutral'} T={T}>{r.state}</Tag>
            </Td>
            <Td T={T} mono align="right">{fmtNum(r.total,0)}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TradeHistoryTable({ T }) {
  const rows = [
    { t:'14:01:22', mkt:'ASTR/KRW', side:'buy',  price:48_210_000, qty:0.02, fee: 482, total: 964_200 },
    { t:'13:58:02', mkt:'ASTR/KRW', side:'buy',  price:48_180_000, qty:0.03, fee: 722, total:1_445_400 },
    { t:'12:44:19', mkt:'HALO/KRW', side:'sell', price:     8_930, qty:540,  fee:2_410, total:4_822_200 },
    { t:'10:12:55', mkt:'LUMI/KRW', side:'buy',  price: 3_802_500, qty:1.2,  fee:2_281, total:4_563_000 },
  ];
  return (
    <table style={tableStyle}>
      <thead><tr>
        <Th T={T}>시각</Th><Th T={T}>마켓</Th><Th T={T}>구분</Th>
        <Th T={T} align="right">체결가</Th><Th T={T} align="right">수량</Th>
        <Th T={T} align="right">수수료</Th><Th T={T} align="right">정산금액</Th>
      </tr></thead>
      <tbody>
        {rows.map((r,i) => (
          <tr key={i}>
            <Td T={T} mono>{r.t}</Td>
            <Td T={T} weight={600}>{r.mkt}</Td>
            <Td T={T} color={r.side==='buy'?T.up:T.down} weight={700}>{r.side==='buy'?'매수':'매도'}</Td>
            <Td T={T} mono align="right">{fmtNum(r.price,0)}</Td>
            <Td T={T} mono align="right">{r.qty}</Td>
            <Td T={T} mono align="right" color={T.text3}>{fmtNum(r.fee,0)}</Td>
            <Td T={T} mono align="right" weight={600}>{fmtNum(r.total,0)}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AssetsTable({ T, holdings, markets }) {
  const rows = holdings.map(h => {
    const m = markets.find(x => x.sym === h.sym);
    const current = m.price;
    const value = current * h.qty;
    const cost = h.avg * h.qty;
    const pnl = value - cost;
    const pnlPct = (pnl / cost) * 100;
    return { ...h, name: m.name, current, value, cost, pnl, pnlPct };
  });
  return (
    <table style={tableStyle}>
      <thead><tr>
        <Th T={T}>자산</Th>
        <Th T={T} align="right">보유수량</Th>
        <Th T={T} align="right">평균매수가</Th>
        <Th T={T} align="right">현재가</Th>
        <Th T={T} align="right">평가금액</Th>
        <Th T={T} align="right">평가손익</Th>
        <Th T={T} align="right">수익률</Th>
      </tr></thead>
      <tbody>
        {rows.map(r => {
          const col = r.pnl >= 0 ? T.up : T.down;
          return (
            <tr key={r.sym}>
              <Td T={T}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: 6,
                    background: T.brandSoft, color: T.brandInk,
                    fontWeight: 800, fontSize: 10, letterSpacing: 0.3,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{r.sym}</div>
                  <div>
                    <div style={{ fontWeight: 600, color: T.text }}>{r.sym}</div>
                    <div style={{ fontSize: 10.5, color: T.text3 }}>{r.name}</div>
                  </div>
                </div>
              </Td>
              <Td T={T} mono align="right">{r.qty}</Td>
              <Td T={T} mono align="right" color={T.text2}>{fmtNum(r.avg,0)}</Td>
              <Td T={T} mono align="right">{fmtNum(r.current,0)}</Td>
              <Td T={T} mono align="right" weight={700}>{fmtKRW(r.value)}</Td>
              <Td T={T} mono align="right" color={col} weight={700}>
                {r.pnl >= 0 ? '+' : ''}{fmtNum(r.pnl, 0)}
              </Td>
              <Td T={T} mono align="right" color={col} weight={700}>{fmtPct(r.pnlPct)}</Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const tableStyle = {
  width: '100%', borderCollapse: 'separate', borderSpacing: 0,
  fontFamily: 'inherit',
};

Object.assign(window, {
  OrderBook, OrderForm, TradeTape, BottomTabs,
});
