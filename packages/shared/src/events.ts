import type { OrderSide, OrderStatus, OrderType } from './dto';

/* ────────────── Commands (API → Matcher) ────────────── */

/**
 * Submit a new order. The API has already:
 *  - validated tick/step/notional,
 *  - locked the user's reserved balance in DB,
 *  - inserted the Order row with status=OPEN, leaveQty=quantity.
 * The matcher's job is to actually match it against the in-memory book and
 * settle the resulting trades.
 */
export interface OrderSubmitCommand {
  v: 1;
  type: 'SUBMIT';
  /** DB-assigned order id (string for JSON safety; matcher converts to bigint). */
  orderId: string;
  userId: string;
  symbol: string;
  side: OrderSide;
  ordType: OrderType;
  /** null for MARKET orders. */
  price: string | null;
  quantity: string;
  ts: number;
}

/**
 * Cancel an order. API has verified ownership and that the order is still
 * cancellable; matcher removes from the book and refunds the locked balance.
 * Idempotent — if the order is already FILLED/CANCELLED the matcher no-ops.
 */
export interface OrderCancelCommand {
  v: 1;
  type: 'CANCEL';
  orderId: string;
  userId: string;
  symbol: string;
  ts: number;
}

export type OrderCommand = OrderSubmitCommand | OrderCancelCommand;

/* ────────────── Events (Matcher → workers) ────────────── */

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
