/**
 * storage.js — localStorage + sessionStorage wrappers.
 * SSR-safe, JSON-serialised, never throws.
 */

function safe(fn) {
    try {
        return fn();
    } catch {
        return null;
    }
}

const local = {
    get: (k) =>
        typeof window !== "undefined"
            ? safe(() => {
                  const r = localStorage.getItem(k);
                  return r ? JSON.parse(r) : null;
              })
            : null,
    set: (k, v) => {
        if (typeof window !== "undefined") safe(() => localStorage.setItem(k, JSON.stringify(v)));
    },
    remove: (k) => {
        if (typeof window !== "undefined") safe(() => localStorage.removeItem(k));
    },
    clear: () => {
        if (typeof window !== "undefined") safe(() => localStorage.clear());
    },
};

const session = {
    get: (k) =>
        typeof window !== "undefined"
            ? safe(() => {
                  const r = sessionStorage.getItem(k);
                  return r ? JSON.parse(r) : null;
              })
            : null,
    set: (k, v) => {
        if (typeof window !== "undefined") safe(() => sessionStorage.setItem(k, JSON.stringify(v)));
    },
    remove: (k) => {
        if (typeof window !== "undefined") safe(() => sessionStorage.removeItem(k));
    },
    clear: () => {
        if (typeof window !== "undefined") safe(() => sessionStorage.clear());
    },
};

export const storage = { ...local, session };
export default storage;
