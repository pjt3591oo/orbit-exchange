import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 20,
        paddingBottom: 12,
        borderBottom: '1px solid var(--border-soft)',
      }}
    >
      <div>
        <h1 style={{ fontSize: 18, margin: 0, fontWeight: 700 }}>{title}</h1>
        {subtitle && (
          <div style={{ marginTop: 4, color: 'var(--text-3)', fontSize: 12 }}>{subtitle}</div>
        )}
      </div>
      {right}
    </div>
  );
}

export function Card({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border-soft)',
        borderRadius: 'var(--radius)',
        padding: padded ? 16 : 0,
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}
