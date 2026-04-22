import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getMarketSocket(): Socket {
  if (!socket) {
    socket = io('/market', {
      transports: ['websocket'],
      autoConnect: true,
    });
  }
  return socket;
}
