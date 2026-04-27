import { useState, type ReactNode } from 'react';

/**
 * Modal for high-risk actions (wallet adjust, force cancel, etc.).
 *
 * UX defenses:
 *   - reason textarea (required)
 *   - "type the target identifier to confirm" challenge (optional but
 *     strongly recommended — prevents fat-finger sending wrong row)
 *   - confirm button red, disabled until challenge matches + reason filled
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = '확인',
  challengeText,
  challengeLabel = '아래 값을 그대로 입력하세요',
  onCancel,
  onConfirm,
  loading = false,
  reasonRequired = true,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  challengeText?: string;
  challengeLabel?: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
  loading?: boolean;
  reasonRequired?: boolean;
}) {
  const [reason, setReason] = useState('');
  const [challenge, setChallenge] = useState('');
  if (!open) return null;
  const challengeOK = !challengeText || challenge === challengeText;
  const reasonOK = !reasonRequired || reason.trim().length > 0;
  const canConfirm = challengeOK && reasonOK && !loading;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)',
          width: 460,
          maxWidth: '90vw',
          padding: 20,
          borderRadius: 'var(--radius)',
          boxShadow: '0 16px 64px rgba(0,0,0,0.18)',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--danger)' }}>{title}</h3>
        <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-2)' }}>{body}</div>

        {challengeText && (
          <div style={{ marginTop: 16 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>
              {challengeLabel}
            </label>
            <div
              style={{
                marginTop: 4,
                fontFamily: 'var(--font-num)',
                fontSize: 12,
                background: 'var(--bg)',
                padding: '6px 8px',
                borderRadius: 4,
              }}
            >
              {challengeText}
            </div>
            <input
              value={challenge}
              onChange={(e) => setChallenge(e.target.value)}
              autoFocus
              style={{
                marginTop: 6,
                width: '100%',
                padding: '6px 8px',
                border: `1px solid ${challengeOK ? 'var(--ok)' : 'var(--border)'}`,
                borderRadius: 4,
                fontFamily: 'var(--font-num)',
                fontSize: 12,
              }}
            />
          </div>
        )}

        {reasonRequired && (
          <div style={{ marginTop: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>
              사유 (필수)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="감사 로그에 기록됩니다"
              style={{
                marginTop: 4,
                width: '100%',
                padding: '6px 8px',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: 12,
                resize: 'vertical',
              }}
            />
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button
            onClick={onCancel}
            disabled={loading}
            style={{
              padding: '6px 14px',
              border: '1px solid var(--border)',
              borderRadius: 4,
              background: 'transparent',
              fontSize: 12,
            }}
          >
            취소
          </button>
          <button
            onClick={() => onConfirm(reason)}
            disabled={!canConfirm}
            style={{
              padding: '6px 14px',
              borderRadius: 4,
              border: 'none',
              background: canConfirm ? 'var(--danger)' : 'var(--text-4)',
              color: 'white',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {loading ? '처리 중…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
