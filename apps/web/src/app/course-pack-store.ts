import { create } from 'zustand';

const ACTIVE_PACK_KEY = 'sysmlv2.activeCoursePackId';

type CoursePackState = {
  activeCoursePackId: string;
  setActiveCoursePackId: (packId: string) => void;
};

export const useCoursePackStore = create<CoursePackState>((set) => ({
  activeCoursePackId: readStoredPackId(),
  setActiveCoursePackId(packId) {
    writeStoredPackId(packId);
    set({ activeCoursePackId: packId });
  }
}));

function readStoredPackId(): string {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_PACK_KEY) || '';
  } catch {
    return '';
  }
}

function writeStoredPackId(packId: string): void {
  try {
    if (packId) globalThis.localStorage?.setItem(ACTIVE_PACK_KEY, packId);
  } catch {
    // In-memory course pack selection still works for this tab.
  }
}
