// Keeps the current drawing on this device (IndexedDB), so a refresh, a back-swipe or a closed tab does not lose
// it. Nothing is sent anywhere. One record: the latest drawing. Every call fails quietly (private windows,
// blocked storage): the app still works, it just cannot bring the drawing back.
const DB = 'steady', STORE = 'drawings', ID = 'current';

let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('no IndexedDB')); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode), req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result); t.onerror = t.onabort = () => reject(t.error);
  }));
}

/** Save {strokes, w, h, saved}; resolves true when it was written. */
export function saveDrawing(data) { return tx('readwrite', (s) => s.put(data, ID)).then(() => true, () => false); }
/** The saved drawing, or null. */
export function loadDrawing() { return tx('readonly', (s) => s.get(ID)).then((v) => v || null, () => null); }
