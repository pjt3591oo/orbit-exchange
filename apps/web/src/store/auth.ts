import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  accessToken: string | null;
  userId: string | null;
  email: string | null;
  setTokens: (t: { accessToken: string; userId: string; email: string }) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      userId: null,
      email: null,
      setTokens: (t) => set({ accessToken: t.accessToken, userId: t.userId, email: t.email }),
      clear: () => set({ accessToken: null, userId: null, email: null }),
    }),
    { name: 'orbit-auth' },
  ),
);
