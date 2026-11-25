export const TOUR_STORAGE_KEY = "undertree.tour.completed.v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function hasCompletedTour(storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(TOUR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTourCompleted(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(TOUR_STORAGE_KEY, "1");
  } catch {
    // ignore storage quota / private mode restrictions
  }
}

export function resetTourCompletion(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(TOUR_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function shouldStartTourFromUrl(search: string): boolean {
  const params = new URLSearchParams(search);
  const flag = params.get("tour");
  return flag === "1" || flag === "true";
}


export interface TourLifecycleState {
  open: boolean;
  completed: boolean;
}

/**
 * Pure state transition for tour dismissal vs completion:
 * dismissing closes the tour WITHOUT persisting completion,
 * while finishing closes the tour AND persists completion.
 */
export function applyTourAction(
  state: TourLifecycleState,
  action: "dismiss" | "finish",
  storage: StorageLike | null = defaultStorage()
): TourLifecycleState {
  if (action === "finish") {
    markTourCompleted(storage);
    return { open: false, completed: true };
  }
  return { ...state, open: false };
}
