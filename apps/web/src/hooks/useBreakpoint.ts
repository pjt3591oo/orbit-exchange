import { useEffect, useState } from 'react';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const BP_MOBILE = 860;
const BP_DESKTOP = 1280;

function detect(): Breakpoint {
  if (typeof window === 'undefined') return 'desktop';
  const w = window.innerWidth;
  if (w < BP_MOBILE) return 'mobile';
  if (w < BP_DESKTOP) return 'tablet';
  return 'desktop';
}

/**
 * Subscribes to window resize and returns the current breakpoint bucket.
 *
 *   mobile   : < 860
 *   tablet   : 860–1279
 *   desktop  : ≥ 1280
 */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() => detect());
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setBp(detect()));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return bp;
}
