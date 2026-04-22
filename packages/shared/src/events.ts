import type { OrderSide, OrderStatus, OrderType } from './dto';

export interface TradeEvent {
  v: 1;
  type: 'TRADE';
  id: string;
  sequence: number;
  market: string;
  price: string;
  quantity: string;
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
  makerSide: OrderSide;
  takerSide: OrderSide;
  ts: number;
}

export interface OrderEvent {
  v: 1;
  type: 'ORDER_ADDED' | 'ORDER_UPDATED' | 'ORDER_CANCELLED';
  orderId: string;
  userId: string;
  market: string;
  side: OrderSide;
  orderType: OrderType;
  price: string | null;
  quantity: string;
  leaveQty: string;
  filledQty: string;
  status: OrderStatus;
  ts: number;
}

export interface OrderbookEvent {
  v: 1;
  type: 'ORDERBOOK_SNAPSHOT';
  market: string;
  seq: number;
  asks: Array<{ price: string; quantity: string }>;
  bids: Array<{ price: string; quantity: string }>;
  ts: number;
}

export type UserNotificationType =
  | 'ORDER_FILLED'
  | 'ORDER_PARTIALLY_FILLED'
  | 'ORDER_CANCELLED'
  | 'ORDER_REJECTED';

export interface UserEvent {
  v: 1;
  userId: string;
  type: UserNotificationType;
  payload: {
    orderId?: string;
    market?: string;
    price?: string;
    quantity?: string;
    filled?: string;
    reason?: string;
  };
  ts: number;
}
