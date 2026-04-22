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
import { useBreakpoint } from '../hooks/useBreakpoint';

interface MarketRow {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}

type MobileTab = 'chart' | 'book' | 'form' | 'log';

export function TradePage() {
  const { symbol = 'BTC-KRW' } = useParams();
  const [pickedPrice, setPickedPrice] = useState<string | null>(null);
  const [marketOpen, setMarketOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('chart');
  const bp = useBreakpoint();

  const { data: markets } = useQuery({
    queryKey: ['markets'],
    queryFn: async () => (await api.get<MarketRow[]>('/markets')).data,
  });
  const current = markets?.find((m) => m.symbol === symbol);
  const quoteAsset = current?.quoteAsset ?? symbol.split('-')[1] ?? 'KRW';
  const baseAsset = current?.baseAsset ?? symbol.split('-')[0];

  const handlePickPrice = (p: string) => {
    setPickedPrice(p);
    if (bp === 'mobile') setMobileTab('form');
  };

  const strip = (
    <SymbolStrip
      symbol={symbol}
      baseAsset={baseAsset}
      quoteAsset={quoteAsset}
      onMarketButtonClick={bp === 'desktop' ? undefined : () => setMarketOpen((v) => !v)}
    />
  );

  if (bp === 'mobile') {
    const tabs: Array<{ k: MobileTab; l: string }> = [
      { k: 'chart', l: '차트' },
      { k: 'book', l: '호가' },
      { k: 'form', l: '주문' },
      { k: 'log', l: '내역' },
    ];
    return (
      <div style={{ width: '100%', height: '100%', background: T.bg, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {strip}
        <div
          style={{
            display: 'flex',
            gap: 0,
            borderBottom: `1px solid ${T.border}`,
            background: T.card,
            overflowX: 'auto',
            flexShrink: 0,
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.k}
              onClick={() => setMobileTab(t.k)}
              style={{
                flex: 1,
                minWidth: 80,
                border: 'none',
                background: 'transparent',
                fontSize: 12.5,
                fontWeight: 600,
                color: mobileTab === t.k ? T.text : T.text3,
                padding: '10px 14px',
                borderBottom: mobileTab === t.k ? `2px solid ${T.brand}` : '2px solid transparent',
                marginBottom: -1,
                cursor: 'pointer',
              }}
            >
              {t.l}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {mobileTab === 'chart' && <ChartPanel symbol={symbol} />}
          {mobileTab === 'book' && (
            <OrderbookPanel symbol={symbol} quoteAsset={quoteAsset} onPickPrice={handlePickPrice} />
          )}
          {mobileTab === 'form' && <OrderForm symbol={symbol} pickedPrice={pickedPrice} />}
          {mobileTab === 'log' && <BottomTabs symbol={symbol} />}
        </div>
        <MarketDrawer open={marketOpen} onClose={() => setMarketOpen(false)} symbol={symbol} />
      </div>
    );
  }

  if (bp === 'tablet') {
    // 3-column: [chart+tape] | [orderbook] | [form], market list as drawer
    return (
      <div style={{ width: '100%', height: '100%', background: T.bg, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {strip}
        <div
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) 280px 260px',
            gridTemplateRows: '1fr 220px',
            gap: 1,
            background: T.border,
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <div style={{ gridRow: '1 / 2', display: 'grid', gridTemplateRows: '1fr 180px', gap: 1, background: T.border, minHeight: 0 }}>
            <ChartPanel symbol={symbol} />
            <TradesPanel symbol={symbol} />
          </div>
          <div style={{ gridRow: '1 / 2' }}>
            <OrderbookPanel symbol={symbol} quoteAsset={quoteAsset} onPickPrice={handlePickPrice} />
          </div>
          <div style={{ gridRow: '1 / 2' }}>
            <OrderForm symbol={symbol} pickedPrice={pickedPrice} />
          </div>
          <div style={{ gridColumn: '1 / -1', gridRow: '2 / 3' }}>
            <BottomTabs symbol={symbol} />
          </div>
        </div>
        <MarketDrawer open={marketOpen} onClose={() => setMarketOpen(false)} symbol={symbol} />
      </div>
    );
  }

  // desktop
  return (
    <div style={{ width: '100%', height: '100%', background: T.bg, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {strip}
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '260px minmax(0,1fr) 320px 300px',
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
          <OrderbookPanel symbol={symbol} quoteAsset={quoteAsset} onPickPrice={handlePickPrice} />
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

function MarketDrawer({
  open,
  onClose,
  symbol,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
}) {
  if (!open) return null;
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(14,17,22,0.4)',
          zIndex: 70,
        }}
      />
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: 300,
          maxWidth: '85vw',
          background: T.card,
          zIndex: 71,
          boxShadow: '0 0 40px rgba(14,17,22,0.15)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            borderBottom: `1px solid ${T.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 700 }}>마켓</span>
          <button
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              fontSize: 18,
              color: T.text2,
              cursor: 'pointer',
              padding: 0,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <MarketList selected={symbol} />
        </div>
      </div>
    </>
  );
}
