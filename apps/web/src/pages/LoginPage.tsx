import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuthStore } from '../store/auth';
import { T } from '../design/tokens';
import { Logo } from '../design/atoms';

export function LoginPage() {
  const [email, setEmail] = useState('alice@orbit.dev');
  const [password, setPassword] = useState('orbit1234!');
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const setTokens = useAuthStore((s) => s.setTokens);
  const nav = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const { data } = await api.post(`/auth/${mode === 'login' ? 'login' : 'signup'}`, {
        email,
        password,
      });
      setTokens(data);
      nav('/trade/BTC-KRW');
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? '요청 실패');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: T.bg,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: 380,
          padding: 28,
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: '0 2px 8px rgba(14,17,22,0.04)',
        }}
      >
        <Link
          to="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 20,
            fontWeight: 800,
            color: T.text,
            marginBottom: 8,
          }}
        >
          <Logo size={26} color={T.brand} />
          ORBIT
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: T.text3,
              letterSpacing: 1,
              marginLeft: 4,
            }}
          >
            EXCHANGE
          </span>
        </Link>

        <div style={{ display: 'flex', gap: 4, fontSize: 12 }}>
          {(['login', 'signup'] as const).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => setMode(m)}
              style={{
                flex: 1,
                border: 'none',
                background: mode === m ? T.text : T.hover,
                color: mode === m ? '#fff' : T.text2,
                fontWeight: 700,
                padding: '8px 0',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              {m === 'login' ? '로그인' : '회원가입'}
            </button>
          ))}
        </div>

        <Field label="이메일">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            required
            style={inputStyle()}
          />
        </Field>
        <Field label="비밀번호">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            required
            minLength={8}
            style={inputStyle()}
          />
        </Field>

        {err && (
          <div style={{ color: T.down, fontSize: 12, fontWeight: 600 }}>{err}</div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            background: T.brand,
            color: '#fff',
            border: 'none',
            fontSize: 13,
            fontWeight: 700,
            padding: '10px 0',
            borderRadius: 6,
            cursor: 'pointer',
            letterSpacing: 0.5,
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? '...' : mode === 'login' ? '로그인' : '계정 만들기'}
        </button>

        <div
          style={{
            fontSize: 11,
            color: T.text3,
            textAlign: 'center',
            marginTop: 6,
          }}
        >
          데모 계정: alice@orbit.dev / orbit1234!
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: T.text3,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    width: '100%',
    background: T.card,
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    padding: '9px 10px',
    fontSize: 13,
    color: T.text,
    outline: 'none',
  };
}
