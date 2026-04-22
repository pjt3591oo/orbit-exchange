export type OrderSide = 'BID' | 'ASK';
export type OrderType = 'LIMIT' | 'MARKET';
export type OrderStatus = 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export interface MarketDto {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: string;
  stepSize: string;
  minNotional: string;
  takerFeeBp: number;
  makerFeeBp: number;
  enabled: boolean;
}

export interface OrderbookLevel {
  price: string;
  quantity: string;
}

export interface OrderbookSnapshot {
  symbol: string;
  seq: number;
  asks: OrderbookLevel[];
  bids: OrderbookLevel[];
  ts: number;
}

export interface TradeDto {
  id: string;
  sequence: number;
  market: string;
  price: string;
  quantity: string;
  takerSide: OrderSide;
  ts: number;
}

export interface OrderDto {
  id: string;
  market: string;
  side: OrderSide;
  type: OrderType;
  price: string | null;
  quantity: string;
  leaveQty: string;
  filledQty: string;
  status: OrderStatus;
  createdAt: string;
}

export interface CandleDto {
  market: string;
  interval: string;
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface WalletDto {
  asset: string;
  balance: string;
  locked: string;
}

export interface CreateOrderBody {
  market: string;
  side: OrderSide;
  type: OrderType;
  price?: string;
  quantity: string;
}
