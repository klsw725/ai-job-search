import { useSyncExternalStore } from "react";

type PanelState = { open: boolean; sessionId: string | null };

let state: PanelState = { open: false, sessionId: null };
const listeners = new Set<() => void>();

function set(next: PanelState) {
  state = next;
  for (const l of listeners) l();
}

export const panel = {
  show: (sessionId: string | null = state.sessionId) => set({ open: true, sessionId }),
  hide: () => set({ ...state, open: false }),
  toggle: () => set({ ...state, open: !state.open }),
  select: (sessionId: string | null) => set({ ...state, sessionId }),
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const read = () => state;

export function usePanel(): PanelState {
  return useSyncExternalStore(subscribe, read);
}
