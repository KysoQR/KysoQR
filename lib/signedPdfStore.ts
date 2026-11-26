/**
 * Browser-local copy of each signed PDF, keyed by the signing round's code
 * (orgIdSigned), so a "5 phiên ký gần nhất" entry on the home page can be
 * reopened in the signing wizard without spending one of identityKey's ~5
 * CAS downloads (and still works after identityKey's ~1-day expiry).
 *
 * IndexedDB rather than localStorage: PDFs are binary and can be several MB,
 * well past localStorage's ~5MB string budget. Only the codes still in the
 * recent list are kept (see `pruneSignedPdfs`), so at most ~5 files.
 *
 * Every function is best-effort and never throws -- IndexedDB can be missing
 * (SSR), blocked (some private-browsing modes) or full; reads then return
 * null and writes are skipped, and callers fall back to the old behaviour.
 */

const DB_NAME = 'kysoqr';
const DB_VERSION = 1;
const STORE = 'signedPdfs';

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Runs one transaction on the store and resolves with `read`'s result (or
 * null on any failure), closing the connection afterwards. */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest | void,
  read?: (request: IDBRequest) => T
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(request && read ? read(request) : null);
      };
      tx.onerror = () => {
        db.close();
        resolve(null);
      };
      tx.onabort = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export async function saveSignedPdf(code: string, blob: Blob): Promise<void> {
  await withStore('readwrite', (store) => store.put(blob, code));
}

export async function getSignedPdf(code: string): Promise<Blob | null> {
  return withStore(
    'readonly',
    (store) => store.get(code),
    (request) => (request.result instanceof Blob ? request.result : null)
  );
}

/** Deletes every stored PDF whose code is not in `keepCodes` (the recent
 * list plus the session currently on screen), so storage never grows past
 * that. A pending round's original file is stored the same way, under its
 * `pending:<signRequestId>` code. */
export async function pruneSignedPdfs(keepCodes: string[]): Promise<void> {
  const keep = new Set(keepCodes);
  await withStore('readwrite', (store) => {
    const cursorRequest = store.openKeyCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      if (!keep.has(String(cursor.key))) store.delete(cursor.key);
      cursor.continue();
    };
  });
}
