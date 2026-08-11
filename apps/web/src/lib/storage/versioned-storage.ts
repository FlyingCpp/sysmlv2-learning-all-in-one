export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface VersionedStorageOptions<T> {
  key: string;
  version: number;
  storage?: KeyValueStorage | null;
  fallback: T | (() => T);
  migrate?: (data: unknown, fromVersion: number) => T | null | undefined;
}

interface VersionedPayload<T> {
  version: number;
  data: T;
  updatedAt: string;
}

export function readVersionedStorage<T>(options: VersionedStorageOptions<T>): T {
  const storage = resolveStorage(options.storage);
  if (!storage) return fallbackValue(options.fallback);
  const raw = storage.getItem(options.key);
  if (!raw) return fallbackValue(options.fallback);
  try {
    const payload = JSON.parse(raw) as Partial<VersionedPayload<unknown>>;
    if (payload.version === options.version) return payload.data as T;
    const migrated = options.migrate?.(payload.data, Number(payload.version || 0));
    if (migrated !== null && migrated !== undefined) {
      writeVersionedStorage({ ...options, fallback: migrated }, migrated);
      return migrated;
    }
  } catch {
    storage.removeItem(options.key);
  }
  return fallbackValue(options.fallback);
}

export function writeVersionedStorage<T>(options: VersionedStorageOptions<T>, data: T): void {
  const storage = resolveStorage(options.storage);
  if (!storage) return;
  const payload: VersionedPayload<T> = {
    version: options.version,
    data,
    updatedAt: new Date().toISOString()
  };
  storage.setItem(options.key, JSON.stringify(payload));
}

export function updateVersionedStorage<T>(
  options: VersionedStorageOptions<T>,
  updater: (current: T) => T
): T {
  const next = updater(readVersionedStorage(options));
  writeVersionedStorage(options, next);
  return next;
}

export function removeVersionedStorage(options: Pick<VersionedStorageOptions<unknown>, 'key' | 'storage'>): void {
  resolveStorage(options.storage)?.removeItem(options.key);
}

export function createMemoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    }
  };
}

function resolveStorage(storage?: KeyValueStorage | null): KeyValueStorage | null {
  if (storage !== undefined) return storage;
  return globalThis.localStorage || null;
}

function fallbackValue<T>(fallback: T | (() => T)): T {
  return typeof fallback === 'function' ? (fallback as () => T)() : fallback;
}
