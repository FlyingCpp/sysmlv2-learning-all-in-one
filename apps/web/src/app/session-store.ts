import { create } from 'zustand';
import type { UserProfile } from '../lib/course/types';

type SessionStatus = 'idle' | 'loading' | 'ready' | 'failed';

type SessionState = {
  user: UserProfile | null;
  status: SessionStatus;
  error: string;
  setStatus: (status: SessionStatus, error?: string) => void;
  setSession: (user: UserProfile | null) => void;
  clearSession: (error?: string) => void;
  hasPermission: (permission: string) => boolean;
};

export const useSessionStore = create<SessionState>((set, get) => ({
  user: null,
  status: 'idle',
  error: '',
  setStatus(status, error = '') {
    set({ status, error });
  },
  setSession(user) {
    set({
      user,
      status: 'ready',
      error: ''
    });
  },
  clearSession(error = '') {
    set({ user: null, status: 'ready', error });
  },
  hasPermission(permission) {
    return Boolean(get().user?.permissions?.includes(permission));
  }
}));
