import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
} from 'lightweight-charts';
import { api } from '../../lib/api';
import { getMarketSocket } from '../../lib/ws';
import { T } from '../../design/tokens';
import { Chip } from '../../design/atoms';
import { CANDLE_INTERVAL_SECONDS, type CandleInterval } from '@orbit/shared';

interface CandleRow {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

const TF_OPTIONS: Array<{ label: string; interval: CandleInterval }> = [
  { label: '1m', interval: 'M1' },
  { label: '5m', interval: 'M5' },
  { label: '15m', interval: 'M15' },
  { label: '1h', interval: 'H1' },
  { label: '4h', interval: 'H4' },
  { label: '1D', interval: 'D1' },
  { label: '1W', interval: 'W1' },
];

export function ChartPanel({ symbol }: { symbol: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [interval, setInterval_] = useState<CandleInterval>('M15');
  const [kind, setKind] = useState<'candle' | 'line'>('candle');
  const lastBarRef = useRef<CandlestickData | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      layout: { background: { color: T.card }, textColor: T.text3 },
      grid: { vertLines: { color: T.borderSoft }, horzLines: { color: T.borderSoft } },
      rightPriceScale: { borderColor: T.border },
      timeScale: { borderColor: T.border, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: T.text3 }, horzLine: { color: T.text3 } },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: T.up,
      downColor: T.down,
      wickUpColor: T.up,
      wickDownColor: T.down,
      borderVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => chart.remove();
  }, []);

  useQuery({
    queryKey: ['candles', symbol, interval],
    queryFn: async () => {
      const { data } = await api.get<CandleRow[]>(`/markets/${symbol}/candles`, {
        params: { interval, limit: 500 },
      });
      const bars: CandlestickData[] = data.map((c) => ({
        time: Math.floor(c.openTime / 1000) as any,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      }));
      seriesRef.current?.setData(bars);
      lastBarRef.current = bars[bars.length - 1] ?? null;
      chartRef.current?.timeScale().fitContent();
      return data;
    },
  });

  // Build the current bar from live trades, bucketing into the selected interval.
  useEffect(() => {
    const sock = getMarketSocket();
    sock.emit('subscribe', { symbol });
    const intervalSec = CANDLE_INTERVAL_SECONDS[interval];
    const handler = (t: { price: string; ts: number; market: string }) => {
      if (t.market !== symbol || !seriesRef.current) return;
      const bucketSec = Math.floor(t.ts / 1000 / intervalSec) * intervalSec;
      const price = Number(t.price);
      const last = lastBarRef.current;
      const next: CandlestickData =
        last && (last.time as number) === bucketSec
          ? {
              time: bucketSec as any,
              open: last.open,
              high: Math.max(last.high, price),
              low: Math.min(last.low, price),
              close: price,
            }
          : {
              time: bucketSec as any,
              open: price,
              high: price,
              low: price,
              close: price,
            };
      lastBarRef.current = next;
      seriesRef.current.update(next);
    };
    sock.on('trade', handler);
    return () => {
      sock.off('trade', handler);
    };
  }, [symbol, interval]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.card }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '8px 12px',
          borderBottom: `1px solid ${T.borderSoft}`,
        }}
      >
        {TF_OPTIONS.map((t) => (
          <Chip
            key={t.interval}
            active={t.interval === interval}
            onClick={() => setInterval_(t.interval)}
            style={{ padding: '4px 8px', fontSize: 11.5 }}
          >
            {t.label}
          </Chip>
        ))}
        <div style={{ width: 1, height: 16, background: T.border, margin: '0 6px' }} />
        {(['candle', 'line'] as const).map((k) => (
          <Chip
            key={k}
            active={k === kind}
            onClick={() => setKind(k)}
            style={{ padding: '4px 8px', fontSize: 11.5 }}
          >
            {k === 'candle' ? '캔들' : '라인'}
          </Chip>
        ))}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            color: T.text3,
            fontSize: 11,
          }}
        >
          <span>M1에서 집계</span>
        </div>
      </div>
      <div ref={ref} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
