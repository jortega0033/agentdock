import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Node 22 may expose an incomplete experimental localStorage global to jsdom.
// Install the browser contract that renderer tests exercise when that happens.
if (typeof window.localStorage?.getItem !== 'function') {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
}

afterEach(cleanup);
