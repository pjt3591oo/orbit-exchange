// modals.jsx — Login, Portfolio, Deposit/Withdraw modals
// All use a shared overlay shell.

function ModalShell({ T, title, onClose, width = 440, children }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 100,
      background: 'rgba(14,17,22,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'orbitFade 160ms ease',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width, maxWidth: '92%', maxHeight: '90%',
        background: T.card, borderRadius: 12,
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: `1px solid ${T.border}`,
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: T.text, whiteSpace: 'nowrap' }}>{title}</span>
          <button onClick={onClose} style={{
            border: 'none', background: 'transparent', cursor: 'pointer',
            width: 28, height: 28, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: T.text3, fontSize: 16,
          }}>✕</button>
        </div>
        <div style={{ overflow: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────
function LoginModal({ T, onClose, onLogin }) {
  const [email, setEmail] = useState('jyunho@example.com');
  const [pw, setPw] = useState('••••••••');
  const [step, setStep] = useState('login'); // login | 2fa
  const [otp, setOtp] = useState('');

  if (step === '2fa') {
    return (
      <ModalShell T={T} title="2단계 인증" onClose={onClose} width={400}>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 12.5, color: T.text2, lineHeight: 1.5 }}>
            OTP 앱에 표시된 6자리 인증번호를 입력해주세요.
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <input key={i}
                value={otp[i] || ''}
                onChange={e => {
                  const v = e.target.value.slice(-1);
                  const arr = otp.split('');
                  arr[i] = v;
                  setOtp(arr.join(''));
                  if (v) {
                    const next = e.target.parentElement.children[i + 1];
                    if (next) next.focus();
                  }
                }}
                maxLength={1}
                style={{
                  width: 44, height: 52, textAlign: 'center',
                  fontFamily: 'var(--font-num)', fontSize: 22, fontWeight: 700,
                  color: T.text, border: `1.5px solid ${otp[i] ? T.brand : T.border}`,
                  borderRadius: 8, outline: 'none', background: T.card,
                }} />
            ))}
          </div>
          <div style={{ fontSize: 11, color: T.text3, textAlign: 'center' }}>
            남은 시간 <span style={{ color: T.up, fontWeight: 700 }}>02:47</span>
          </div>
          <button onClick={() => { onLogin(); onClose(); }} style={primaryBtn(T)}>
            확인
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell T={T} title="ORBIT 로그인" onClose={onClose} width={400}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field T={T} label="이메일" value={email} onChange={setEmail} />
        <Field T={T} label="비밀번호" value={pw} onChange={setPw} type="password" />
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 11.5, color: T.text3,
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" defaultChecked style={{ accentColor: T.brand }} />
            로그인 상태 유지
          </label>
          <a style={{ color: T.brandInk, cursor: 'pointer' }}>비밀번호를 잊으셨나요?</a>
        </div>
        <button onClick={() => setStep('2fa')} style={primaryBtn(T)}>
          로그인
        </button>
        <div style={{
          textAlign: 'center', fontSize: 11, color: T.text3,
          display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0',
        }}>
          <div style={{ flex: 1, height: 1, background: T.border }} />
          <span>또는</span>
          <div style={{ flex: 1, height: 1, background: T.border }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <button style={socialBtn(T)}>카카오</button>
          <button style={socialBtn(T)}>애플</button>
        </div>
        <div style={{ textAlign: 'center', fontSize: 12, color: T.text3, marginTop: 4 }}>
          아직 회원이 아니신가요?{' '}
          <span style={{ color: T.brandInk, fontWeight: 600, cursor: 'pointer' }}>회원가입</span>
        </div>
      </div>
    </ModalShell>
  );
}

function Field({ T, label, value, onChange, type = 'text' }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: T.text3, marginBottom: 5, fontWeight: 600 }}>{label}</div>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%', border: `1px solid ${T.border}`, borderRadius: 6,
          padding: '10px 12px', fontFamily: 'inherit', fontSize: 13,
          color: T.text, outline: 'none', background: T.card,
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

function primaryBtn(T) {
  return {
    background: T.text, color: '#fff', border: 'none',
    fontFamily: 'inherit', fontSize: 13, fontWeight: 700,
    padding: '12px', borderRadius: 6, cursor: 'pointer',
  };
}
function socialBtn(T) {
  return {
    border: `1px solid ${T.border}`, background: T.card,
    fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
    color: T.text, padding: '10px', borderRadius: 6, cursor: 'pointer',
  };
}

// ─────────────────────────────────────────────────────────────
// Portfolio
// ─────────────────────────────────────────────────────────────
function PortfolioModal({ T, holdings, markets, onClose }) {
  const rows = holdings.map(h => {
    const m = markets.find(x => x.sym === h.sym);
    return { ...h, name: m.name, current: m.price, chg24: m.chg24,
      value: m.price * h.qty, cost: h.avg * h.qty };
  });
  const krwBalance = 8_420_100;
  const totalValue = rows.reduce((a, r) => a + r.value, 0) + krwBalance;
  const totalCost = rows.reduce((a, r) => a + r.cost, 0) + krwBalance;
  const totalPnl = totalValue - totalCost;
  const pnlPct = (totalPnl / totalCost) * 100;
  const col = totalPnl >= 0 ? T.up : T.down;

  // portfolio share
  const nonCash = rows.reduce((a, r) => a + r.value, 0);

  return (
    <ModalShell T={T} title="내 포트폴리오" onClose={onClose} width={680}>
      <div style={{ padding: 20 }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12,
          marginBottom: 20,
        }}>
          <Stat T={T} label="총 평가자산" value={fmtKRW(totalValue)} emphasize />
          <Stat T={T} label="총 평가손익" value={(totalPnl >= 0 ? '+' : '') + fmtNum(totalPnl, 0)} color={col} />
          <Stat T={T} label="총 수익률" value={fmtPct(pnlPct)} color={col} />
        </div>

        {/* allocation bar */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: T.text3, fontWeight: 600, marginBottom: 6 }}>자산 배분</div>
          <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden' }}>
            {rows.map((r, i) => (
              <div key={r.sym} style={{
                width: `${(r.value / totalValue) * 100}%`,
                background: `oklch(${0.55 + i * 0.04} 0.18 ${220 + i * 24})`,
              }} />
            ))}
            <div style={{
              width: `${(krwBalance / totalValue) * 100}%`,
              background: T.text3,
            }} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8, fontSize: 11 }}>
            {rows.map((r, i) => (
              <div key={r.sym} style={{ display: 'flex', alignItems: 'center', gap: 5, color: T.text2 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: 2,
                  background: `oklch(${0.55 + i * 0.04} 0.18 ${220 + i * 24})`,
                }} />
                {r.sym} · {((r.value / totalValue) * 100).toFixed(1)}%
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: T.text2 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: T.text3 }} />
              KRW · {((krwBalance / totalValue) * 100).toFixed(1)}%
            </div>
          </div>
        </div>

        <div style={{
          border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden',
        }}>
          <table style={tableStyle}>
            <thead><tr>
              <Th T={T}>자산</Th>
              <Th T={T} align="right">보유</Th>
              <Th T={T} align="right">평가금액</Th>
              <Th T={T} align="right">평균가</Th>
              <Th T={T} align="right">수익률</Th>
            </tr></thead>
            <tbody>
              {rows.map(r => {
                const pnl = r.value - r.cost;
                const p = (pnl / r.cost) * 100;
                const c2 = pnl >= 0 ? T.up : T.down;
                return (
                  <tr key={r.sym}>
                    <Td T={T}>
                      <div style={{ fontWeight: 600 }}>{r.sym}</div>
                      <div style={{ fontSize: 10.5, color: T.text3 }}>{r.name}</div>
                    </Td>
                    <Td T={T} mono align="right">{r.qty}</Td>
                    <Td T={T} mono align="right" weight={600}>{fmtKRW(r.value)}</Td>
                    <Td T={T} mono align="right" color={T.text3}>{fmtNum(r.avg, 0)}</Td>
                    <Td T={T} mono align="right" color={c2} weight={700}>{fmtPct(p)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </ModalShell>
  );
}

function Stat({ T, label, value, emphasize, color }) {
  return (
    <div style={{
      border: `1px solid ${T.border}`, borderRadius: 8,
      padding: '12px 14px', background: emphasize ? T.bgAlt : T.card,
    }}>
      <div style={{ fontSize: 10.5, color: T.text3, fontWeight: 600, letterSpacing: 0.3 }}>{label}</div>
      <div style={{
        marginTop: 5,
        fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
        fontSize: emphasize ? 22 : 18, fontWeight: 700,
        color: color || T.text, letterSpacing: -0.3,
      }}>{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Deposit / withdraw
// ─────────────────────────────────────────────────────────────
function DepositModal({ T, onClose }) {
  const [mode, setMode] = useState('deposit');
  const [asset, setAsset] = useState('KRW');

  return (
    <ModalShell T={T} title={mode === 'deposit' ? '입금' : '출금'} onClose={onClose} width={440}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0,
          background: T.hover, borderRadius: 6, padding: 3,
        }}>
          {[{k:'deposit',l:'입금'},{k:'withdraw',l:'출금'}].map(x => (
            <button key={x.k} onClick={() => setMode(x.k)} style={{
              border: 'none',
              background: mode === x.k ? T.card : 'transparent',
              color: mode === x.k ? T.text : T.text2,
              fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
              padding: '8px 0', borderRadius: 4, cursor: 'pointer',
              boxShadow: mode === x.k ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
            }}>{x.l}</button>
          ))}
        </div>

        <div>
          <div style={{ fontSize: 11, color: T.text3, marginBottom: 5, fontWeight: 600 }}>자산 선택</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['KRW','ASTR','LUMI','NOVA'].map(a => (
              <button key={a} onClick={() => setAsset(a)} style={{
                border: `1px solid ${asset===a ? T.text : T.border}`,
                background: asset===a ? T.text : T.card,
                color: asset===a ? '#fff' : T.text2,
                fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
                padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
              }}>{a}</button>
            ))}
          </div>
        </div>

        {asset === 'KRW' ? (
          <>
            <div style={{
              background: T.brandSoft, border: `1px solid ${T.brandSoft}`,
              borderRadius: 8, padding: 14,
            }}>
              <div style={{ fontSize: 11, color: T.brandInk, fontWeight: 600, marginBottom: 4 }}>
                {mode === 'deposit' ? '입금 전용 계좌' : '출금 계좌'}
              </div>
              <div style={{
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                fontSize: 16, color: T.text, fontWeight: 700,
              }}>케이뱅크 · 100-204-38219-4</div>
              <div style={{ fontSize: 11.5, color: T.text2, marginTop: 4 }}>예금주 · 정윤호</div>
            </div>
            <Field T={T} label={mode === 'deposit' ? '입금 금액' : '출금 금액'} value="1,000,000" onChange={() => {}} />
          </>
        ) : (
          <>
            <div style={{
              background: T.bgAlt, border: `1px solid ${T.border}`,
              borderRadius: 8, padding: 14,
            }}>
              <div style={{ fontSize: 11, color: T.text3, fontWeight: 600, marginBottom: 6 }}>
                {mode === 'deposit' ? `${asset} 입금 주소` : '출금 주소 입력'}
              </div>
              {mode === 'deposit' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {/* QR placeholder */}
                  <div style={{
                    width: 78, height: 78, background: T.text, borderRadius: 6,
                    display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 0, padding: 4,
                  }}>
                    {Array.from({ length: 49 }).map((_, i) => (
                      <div key={i} style={{
                        background: ((i * 17 + 3) % 7) < 3 ? '#fff' : 'transparent',
                      }} />
                    ))}
                  </div>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{
                      fontFamily: 'var(--font-num)', fontSize: 11,
                      color: T.text, wordBreak: 'break-all', fontWeight: 500,
                    }}>orb1q{asset.toLowerCase()}x8k3p2m9nrlv7hqz4t6fwxe</div>
                    <button style={{
                      marginTop: 6,
                      border: `1px solid ${T.border}`, background: T.card,
                      fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
                      color: T.text, padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
                    }}>주소 복사</button>
                  </div>
                </div>
              ) : (
                <Field T={T} label="" value="" onChange={() => {}} />
              )}
            </div>
            <div style={{
              background: T.warnBg, border: `1px solid ${T.warnBg}`,
              borderRadius: 6, padding: '10px 12px', fontSize: 11.5,
              color: T.warn, lineHeight: 1.5,
            }}>
              {asset} 네트워크가 아닌 주소로 입금 시 자산이 영구 손실됩니다.
              최소 입금금액은 {asset === 'ASTR' ? '0.001' : '0.1'} {asset}.
            </div>
          </>
        )}

        <div style={{
          display: 'flex', justifyContent: 'space-between', fontSize: 11.5,
          color: T.text3, padding: '8px 0',
        }}>
          <span>사용 가능 잔액</span>
          <span style={{
            fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
            color: T.text, fontWeight: 600,
          }}>{asset === 'KRW' ? '₩8,420,100' : '0.4821 ASTR'}</span>
        </div>

        <button onClick={onClose} style={primaryBtn(T)}>
          {mode === 'deposit' ? '입금 요청' : '출금 신청'}
        </button>
      </div>
    </ModalShell>
  );
}

// ─────────────────────────────────────────────────────────────
// Staking
// ─────────────────────────────────────────────────────────────
function StakingModal({ T, onClose }) {
  const pools = [
    { sym: 'ASTR', name: 'Astrix',    apy: 5.82, lock: '유동형',   tvl: 184_200_000_000, min: 0.1,   staked: 0.18,  reward: 0.0043, featured: true  },
    { sym: 'NOVA', name: 'Nova',      apy: 8.14, lock: '30일 고정', tvl:  72_400_000_000, min: 1,     staked: 0,     reward: 0,      featured: true  },
    { sym: 'LUMI', name: 'Lumina',    apy: 4.10, lock: '유동형',   tvl: 112_800_000_000, min: 0.5,   staked: 4.2,   reward: 0.042,  featured: false },
    { sym: 'KRON', name: 'Kronos',    apy: 11.20, lock: '90일 고정', tvl:  28_700_000_000, min: 5,     staked: 0,     reward: 0,      featured: false },
    { sym: 'HALO', name: 'Halocore',  apy: 3.25, lock: '유동형',   tvl:  15_300_000_000, min: 10,    staked: 820,   reward: 2.64,   featured: false },
    { sym: 'BOLT', name: 'Boltnet',   apy: 14.80, lock: '180일 고정',tvl:  38_400_000_000, min: 50,    staked: 0,     reward: 0,      featured: false },
  ];

  const [selected, setSelected] = React.useState(null);
  const [tab, setTab] = React.useState('all'); // all | mine
  const [amount, setAmount] = React.useState(0);

  const mine = pools.filter(p => p.staked > 0);
  const totalStakedKRW = mine.reduce((a, p) => {
    const m = MARKETS.find(x => x.sym === p.sym);
    return a + (m ? m.price * p.staked : 0);
  }, 0);
  const totalRewardKRW = mine.reduce((a, p) => {
    const m = MARKETS.find(x => x.sym === p.sym);
    return a + (m ? m.price * p.reward : 0);
  }, 0);

  if (selected) {
    const m = MARKETS.find(x => x.sym === selected.sym);
    const totalKRW = m ? m.price * amount : 0;
    const estYearly = amount * selected.apy / 100;
    const estYearlyKRW = m ? m.price * estYearly : 0;
    return (
      <ModalShell T={T} title={`${selected.sym} 스테이킹`} onClose={() => setSelected(null)} width={460}>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 14px', background: T.brandSoft, borderRadius: 8,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: T.brand, color: '#fff', fontWeight: 800, fontSize: 11,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{selected.sym}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{selected.name}</div>
              <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>{selected.lock} · 최소 {selected.min} {selected.sym}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10.5, color: T.text3, fontWeight: 600 }}>연 수익률</div>
              <div style={{
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                fontSize: 18, color: T.up, fontWeight: 800,
              }}>{selected.apy.toFixed(2)}%</div>
            </div>
          </div>

          <div>
            <div style={{ fontSize: 11, color: T.text3, fontWeight: 600, marginBottom: 5 }}>스테이킹 수량</div>
            <div style={{
              display: 'flex', alignItems: 'center',
              border: `1px solid ${T.border}`, borderRadius: 6,
            }}>
              <input type="number" value={amount || ''} onChange={e => setAmount(+e.target.value || 0)}
                placeholder="0.00" style={{
                  flex: 1, border: 'none', outline: 'none', background: 'transparent',
                  fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                  fontSize: 14, color: T.text, padding: '10px 12px', fontWeight: 600,
                }} />
              <span style={{ color: T.text3, fontSize: 11, fontWeight: 600, padding: '0 12px' }}>{selected.sym}</span>
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between', marginTop: 6,
              fontSize: 11, color: T.text3,
            }}>
              <span>≈ ₩{fmtNum(totalKRW, 0)}</span>
              <span>보유 · <span style={{ color: T.text, fontWeight: 600 }}>1.2 {selected.sym}</span></span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4 }}>
            {[25, 50, 75, 100].map(p => (
              <button key={p} onClick={() => setAmount(+(1.2 * p / 100).toFixed(4))} style={{
                border: `1px solid ${T.border}`, background: T.card,
                color: T.text2, fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
                padding: '6px 0', borderRadius: 4, cursor: 'pointer',
              }}>{p}%</button>
            ))}
          </div>

          <div style={{
            background: T.bgAlt, border: `1px solid ${T.borderSoft}`,
            borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <RewardRow T={T} label="연 예상 수익 (복리 미적용)" value={`+${fmtNum(estYearly, 4)} ${selected.sym}`} hint={`≈ ₩${fmtNum(estYearlyKRW, 0)}`} />
            <RewardRow T={T} label="보상 지급" value="매일 자동 지급" />
            <RewardRow T={T} label="락업 기간" value={selected.lock} />
            <RewardRow T={T} label="언스테이킹 대기" value={selected.lock === '유동형' ? '없음' : '7일'} />
          </div>

          <div style={{
            background: T.warnBg, borderRadius: 6,
            padding: '10px 12px', fontSize: 11, color: T.warn, lineHeight: 1.5,
          }}>
            스테이킹 수익률은 변동될 수 있으며, 고정형은 만기 전 출금 시 보상이 제한됩니다.
          </div>

          <button onClick={onClose} style={{
            background: T.text, color: '#fff', border: 'none',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 700,
            padding: '12px', borderRadius: 6, cursor: 'pointer',
          }}>스테이킹 시작</button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell T={T} title="스테이킹" onClose={onClose} width={720}>
      <div style={{ padding: 20 }}>
        {/* Summary */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 18,
        }}>
          <Stat T={T} label="총 스테이킹 자산" value={fmtKRW(totalStakedKRW)} emphasize />
          <Stat T={T} label="누적 보상" value={fmtKRW(totalRewardKRW)} color={T.up} />
          <Stat T={T} label="평균 APY" value="5.64%" color={T.up} />
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
          {[{k:'all',l:'전체 상품'}, {k:'mine',l:`내 스테이킹 (${mine.length})`}].map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} style={{
              border: 'none',
              background: tab === t.k ? T.text : 'transparent',
              color: tab === t.k ? '#fff' : T.text2,
              fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
              padding: '7px 12px', borderRadius: 6, cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}>{t.l}</button>
          ))}
        </div>

        {/* Pool list */}
        <div style={{
          border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden',
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1.2fr 90px',
            padding: '10px 14px', fontSize: 10.5, color: T.text3, fontWeight: 600,
            background: T.bgAlt, borderBottom: `1px solid ${T.borderSoft}`,
            letterSpacing: 0.2,
          }}>
            <span>자산</span>
            <span style={{ textAlign: 'right' }}>APY</span>
            <span>락업</span>
            <span style={{ textAlign: 'right' }}>TVL</span>
            <span style={{ textAlign: 'right' }}></span>
          </div>
          {(tab === 'all' ? pools : mine).map(p => (
            <div key={p.sym} style={{
              display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1.2fr 90px',
              padding: '12px 14px', alignItems: 'center',
              borderBottom: `1px solid ${T.borderSoft}`, fontSize: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 6,
                  background: T.brandSoft, color: T.brandInk, fontWeight: 800,
                  fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{p.sym}</div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ color: T.text, fontWeight: 700 }}>{p.sym}</span>
                    {p.featured && <Tag tone="brand" T={T}>추천</Tag>}
                  </div>
                  <div style={{ fontSize: 10.5, color: T.text3, marginTop: 1 }}>
                    {tab === 'mine'
                      ? `보유 ${p.staked} ${p.sym} · 보상 +${p.reward.toFixed(4)}`
                      : p.name}
                  </div>
                </div>
              </div>
              <div style={{
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                textAlign: 'right', color: T.up, fontWeight: 800, fontSize: 14,
              }}>{p.apy.toFixed(2)}%</div>
              <div style={{ color: T.text2, whiteSpace: 'nowrap' }}>{p.lock}</div>
              <div style={{
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
                textAlign: 'right', color: T.text2,
              }}>₩{fmtAbbr(p.tvl)}</div>
              <div style={{ textAlign: 'right' }}>
                <button onClick={() => { setSelected(p); setAmount(0); }} style={{
                  border: 'none', background: T.text, color: '#fff',
                  fontFamily: 'inherit', fontSize: 11.5, fontWeight: 700,
                  padding: '6px 12px', borderRadius: 5, cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}>{p.staked > 0 ? '관리' : '스테이킹'}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </ModalShell>
  );
}

function RewardRow({ T, label, value, hint }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      fontSize: 11.5, gap: 8,
    }}>
      <span style={{ color: T.text3, whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>
        <span style={{
          fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
          color: T.text, fontWeight: 600, whiteSpace: 'nowrap',
        }}>{value}</span>
        {hint && <span style={{ color: T.text3, marginLeft: 8, whiteSpace: 'nowrap' }}>{hint}</span>}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Notices (공지)
// ─────────────────────────────────────────────────────────────
function NoticesModal({ T, onClose }) {
  const [tab, setTab] = React.useState('all');
  const [open, setOpen] = React.useState(null);

  const notices = [
    { id: 1, cat: '상장',  pin: true,  date: '2026-04-22', title: '[신규상장] BOLT/KRW 원화마켓 오픈',
      body: 'Boltnet(BOLT)의 KRW 마켓이 4월 23일 14:00에 오픈됩니다. 오픈 전 입금은 가능하며 거래는 오픈 시점 이후에 가능합니다. 초기 변동성이 크므로 선지정가 주문을 권장합니다.' },
    { id: 2, cat: '점검',  pin: true,  date: '2026-04-21', title: '[정기점검] 4월 24일 새벽 03:00–05:00 서비스 일시 중단',
      body: '시스템 안정화를 위한 정기점검이 진행됩니다. 점검 시간 중 모든 주문/입출금/지갑 서비스가 일시 중단됩니다.' },
    { id: 3, cat: '이벤트', pin: false, date: '2026-04-20', title: '[이벤트] ASTR 스테이킹 APY 2% 상향 (기간한정)',
      body: '4월 20일부터 5월 4일까지 2주간 ASTR 스테이킹 APY가 기존 5.82%에서 7.82%로 상향 적용됩니다.' },
    { id: 4, cat: '안내',  pin: false, date: '2026-04-19', title: '[안내] 투자자 보호 관련 약관 개정 안내',
      body: '전자금융거래법 개정에 따른 이용약관 개정사항을 안내드립니다. 변경일: 2026-05-01.' },
    { id: 5, cat: '상장',  pin: false, date: '2026-04-18', title: '[상장폐지] VEGA 거래 지원 종료 예정',
      body: 'VEGA 프로젝트 유지보수 미이행으로 5월 10일 15:00에 거래가 종료됩니다. 보유자는 종료 이전까지 처분해주시기 바랍니다.' },
    { id: 6, cat: '이벤트', pin: false, date: '2026-04-15', title: '[이벤트] 신규 회원 대상 수수료 할인 30일',
      body: '등록일로부터 30일간 거래 수수료 50% 할인이 적용됩니다. 첫 원화 입금 시 5,000 KRW 케시백도 함께 지급됩니다.' },
  ];
  const cats = ['전체', '상장', '점검', '이벤트', '안내'];
  const tabKey = tab === 'all' ? null : tab;
  const list = notices.filter(n => !tabKey || n.cat === tabKey);

  if (open) {
    const n = notices.find(x => x.id === open);
    return (
      <ModalShell T={T} title="공지사항" onClose={onClose} width={620}>
        <div style={{ padding: 20 }}>
          <button onClick={() => setOpen(null)} style={{
            border: 'none', background: 'transparent', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 12, color: T.text3, padding: 0,
            marginBottom: 14,
          }}>← 목록으로</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Tag tone="brand" T={T}>{n.cat}</Tag>
            <span style={{
              fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
              fontSize: 11, color: T.text3,
            }}>{n.date}</span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: T.text, lineHeight: 1.4, marginBottom: 14 }}>
            {n.title}
          </div>
          <div style={{
            fontSize: 13, color: T.text2, lineHeight: 1.7,
            paddingTop: 14, borderTop: `1px solid ${T.borderSoft}`,
          }}>{n.body}</div>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell T={T} title="공지사항" onClose={onClose} width={620}>
      <div style={{ padding: '16px 20px 8px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {cats.map(c => {
          const k = c === '전체' ? 'all' : c;
          const active = tab === k;
          return (
            <button key={c} onClick={() => setTab(k)} style={{
              border: `1px solid ${active ? T.text : T.border}`,
              background: active ? T.text : T.card,
              color: active ? '#fff' : T.text2,
              fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
              padding: '6px 12px', borderRadius: 20, cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}>{c}</button>
          );
        })}
      </div>
      <div>
        {list.map(n => (
          <div key={n.id} onClick={() => setOpen(n.id)} style={{
            padding: '14px 20px', borderTop: `1px solid ${T.borderSoft}`,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14,
          }}
            onMouseEnter={e => e.currentTarget.style.background = T.hover}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <div style={{ flexShrink: 0 }}>
              {n.pin ? <Tag tone="up" T={T}>고정</Tag> : <Tag tone="neutral" T={T}>{n.cat}</Tag>}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13, fontWeight: 600, color: T.text,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{n.title}</div>
              <div style={{
                fontSize: 11, color: T.text3, marginTop: 3,
                fontFamily: 'var(--font-num)', fontVariantNumeric: 'tabular-nums',
              }}>{n.date}</div>
            </div>
            <span style={{ color: T.text3, fontSize: 14 }}>›</span>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

Object.assign(window, { ModalShell, LoginModal, PortfolioModal, DepositModal, StakingModal, NoticesModal });
