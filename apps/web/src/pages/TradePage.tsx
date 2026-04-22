import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { T } from '../design/tokens';
import { SymbolStrip } from '../features/trade/SymbolStrip';
import { MarketList } from '../features/trade/MarketList';
import { ChartPanel } from '../features/trade/ChartPanel';
import { OrderbookPanel } from '../features/trade/OrderbookPanel';
import { OrderForm } from '../features/trade/OrderForm';
import { TradesPanel } from '../features/trade/TradesPanel';
import { BottomTabs } from '../features/trade/BottomTabs';

interface MarketRow {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}

export function TradePage() {
  const { symbol = 'BTC-KRW' } = useParams();
  const [pickedPrice, setPickedPrice] = useState<string | null>(null);

  const { data: markets } = useQuery({
    queryKey: ['markets'],
    queryFn: async () => (await api.get<MarketRow[]>('/markets')).data,
  });
  const current = markets?.find((m) => m.symbol === symbol);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: T.bg,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <SymbolStrip
        symbol={symbol}
        baseAsset={current?.baseAsset ?? symbol.split('-')[0]}
        quoteAsset={current?.quoteAsset ?? symbol.split('-')[1] ?? 'KRW'}
      />

      {/* main 4-column grid + bottom tabs */}
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '260px 1fr 320px 300px',
          gridTemplateRows: '1fr 260px',
          gap: 1,
          background: T.border,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <div style={{ gridRow: '1 / 2' }}>
          <MarketList selected={symbol} />
        </div>

        <div
          style={{
            gridRow: '1 / 2',
            display: 'grid',
            gridTemplateRows: '1fr 200px',
            gap: 1,
            background: T.border,
            minHeight: 0,
          }}
        >
          <ChartPanel symbol={symbol} />
          <TradesPanel symbol={symbol} />
        </div>

        <div style={{ gridRow: '1 / 2' }}>
          <OrderbookPanel
            symbol={symbol}
            quoteAsset={current?.quoteAsset ?? 'KRW'}
            onPickPrice={(p) => setPickedPrice(p)}
          />
        </div>

        <div style={{ gridRow: '1 / 2' }}>
          <OrderForm symbol={symbol} pickedPrice={pickedPrice} />
        </div>

        <div style={{ gridColumn: '1 / -1', gridRow: '2 / 3' }}>
          <BottomTabs symbol={symbol} />
        </div>
      </div>
    </div>
  );
}
