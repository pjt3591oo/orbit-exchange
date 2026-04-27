import { useEffect, useState } from 'react';

/**
 * Cursor-stack pagination state hook.
 *
 * Backends in apps/api/src/admin/* return `{ items, nextCursor }`. The
 * cursor is opaque (BigInt id) — there's no total count, no random-page
 * jump. We give the operator a familiar [이전 | 페이지 N | 다음] strip:
 *
 *   page 1 → cursor = undefined          (no `cursor` query param)
 *   page 2 → cursor = stack[0]           (the nextCursor we got from page 1)
 *   page 3 → cursor = stack[1]           (the nextCursor we got from page 2)
 *
 * Click 다음: push the current response's nextCursor onto the stack.
 * Click 이전: pop the stack — the new top becomes the cursor.
 *
 * Filter changes reset the stack — provide `resetDeps`. Without that,
 * a search-then-paginate combo would carry stale cursors over.
 */
export function useCursorPagination(resetDeps: ReadonlyArray<unknown> = []) {
  const [stack, setStack] = useState<string[]>([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setStack([]), resetDeps);

  const currentCursor: string | undefined =
    stack.length > 0 ? stack[stack.length - 1] : undefined;
  const page = stack.length + 1;

  function pushNext(nextCursor: string | null | undefined) {
    if (!nextCursor) return;
    setStack((s) => [...s, nextCursor]);
  }
  function popPrev() {
    setStack((s) => s.slice(0, -1));
  }
  function reset() {
    setStack([]);
  }

  return { currentCursor, page, pushNext, popPrev, reset, hasPrev: page > 1 };
}

/**
 * Pagination strip — paired with `useCursorPagination`. Render at the
 * bottom of any list table.
 *
 *   <Pagination
 *     page={page}
 *     hasPrev={hasPrev}
 *     hasNext={!!list.data?.nextCursor}
 *     onPrev={popPrev}
 *     onNext={() => pushNext(list.data?.nextCursor)}
 *     loading={list.isFetching}
 *   />
 */
export function Pagination({
  page,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  loading,
  itemsCount,
}: {
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  loading?: boolean;
  /** Optional — number of rows currently rendered. Shown as a hint. */
  itemsCount?: number;
}) {
  // Hide entirely if there's only one page and no items count to show.
  if (!hasPrev && !hasNext && (itemsCount === undefined || itemsCount === 0)) {
    return null;
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        padding: '10px 12px',
        borderTop: '1px solid var(--border-soft)',
      }}
    >
      {itemsCount !== undefined && (
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {itemsCount} 행
        </span>
      )}
      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>·</span>
      <span style={{ fontSize: 11, color: 'var(--text-2)' }}>페이지 {page}</span>
      <button
        disabled={!hasPrev || !!loading}
        onClick={onPrev}
        style={btn(!hasPrev || !!loading)}
      >
        ← 이전
      </button>
      <button
        disabled={!hasNext || !!loading}
        onClick={onNext}
        style={btn(!hasNext || !!loading)}
      >
        다음 →
      </button>
    </div>
  );
}

function btn(disabled: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    fontSize: 11,
    border: '1px solid var(--border)',
    borderRadius: 4,
    background: 'transparent',
    color: disabled ? 'var(--text-4)' : 'var(--text-2)',
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}
