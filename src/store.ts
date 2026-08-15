/**
 * notes.json store — single source of truth for every post-it.
 * Persisted to the plugin's PRIVATE hidden data dir (getPluginDirPath), so cloud
 * sync can't corrupt it. Export/import round-trips to a visible .json backup.
 * In-memory cache with a debounced atomic write; one writer here.
 */
import {NativePluginManager} from 'sn-plugin-lib';
import {
  StickyNative,
  EXPORT_DIR,
  JSON_BACKUP,
  LEGACY_DIR,
  CardPayload,
  blog,
} from './native';

export type FontKey = 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL';
export const FONT_SP: Record<FontKey, number> = {
  XS: 12,
  S: 14,
  M: 18,
  L: 24,
  XL: 30,
  XXL: 38,
};

export interface Note {
  id: string;
  icon: string;
  body: string;
  open: boolean;
  x: number; // window px, -1 = auto-place
  y: number;
  w: number; // window px, -1 = default width
  h: number; // window px, -1 = auto height (wrap)
  collapsed: boolean;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

let cache: Note[] = [];
let fontKey: FontKey = 'M';
let loaded = false;
let notesPath = '';
let settingsPath = '';
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

function notify(): void {
  listeners.forEach(l => {
    try {
      l();
    } catch {}
  });
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function initStore(): Promise<void> {
  if (loaded) return;
  // Private, hidden data dir (not cloud-synced). Fallback to a dot-dir if the
  // native call ever fails, so we still never write data into a synced folder.
  let dataDir = '';
  try {
    dataDir = (await NativePluginManager.getPluginDirPath()) || '';
  } catch {}
  if (!dataDir) dataDir = '/storage/emulated/0/MyStyle/.superstickynote';
  notesPath = `${dataDir}/notes.json`;
  settingsPath = `${dataDir}/settings.json`;

  try {
    await StickyNative?.ensureDir(dataDir);
    let raw = (await StickyNative?.readTextFile(notesPath)) ?? '';
    if (!raw) {
      // One-time migration from the pre-0.4 VISIBLE location.
      const legacy = (await StickyNative?.readTextFile(`${LEGACY_DIR}/notes.json`)) ?? '';
      if (legacy) {
        raw = legacy;
        await StickyNative?.writeFile(notesPath, legacy);
        blog('[store] migrated notes.json from legacy visible dir');
      }
    }
    cache = raw ? (JSON.parse(raw) as Note[]) : [];
    if (!Array.isArray(cache)) cache = [];
  } catch (e) {
    blog(`[store] load failed: ${(e as Error)?.message}`);
    cache = [];
  }

  try {
    let raw = (await StickyNative?.readTextFile(settingsPath)) ?? '';
    if (!raw) {
      const legacy = (await StickyNative?.readTextFile(`${LEGACY_DIR}/settings.json`)) ?? '';
      if (legacy) {
        raw = legacy;
        await StickyNative?.writeFile(settingsPath, legacy);
      }
    }
    const s = raw ? JSON.parse(raw) : {};
    if (s && FONT_SP[s.fontKey as FontKey]) fontKey = s.fontKey;
  } catch {}
  loaded = true;
}

// ---- Settings (global) --------------------------------------------------

export function getFontKey(): FontKey {
  return fontKey;
}

export function fontSp(): number {
  return FONT_SP[fontKey];
}

export function setFontKey(k: FontKey): void {
  fontKey = k;
  StickyNative?.writeFile(settingsPath, JSON.stringify({fontKey})).catch(() => {});
  notify();
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    StickyNative?.writeFile(notesPath, JSON.stringify(cache, null, 2)).catch(e =>
      blog(`[store] save failed: ${(e as Error)?.message}`),
    );
  }, 400);
}

/** Force an immediate flush (e.g. before the process may be torn down). */
export async function flush(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    await StickyNative?.writeFile(notesPath, JSON.stringify(cache, null, 2));
  } catch {}
}

export function getAll(): Note[] {
  return cache.slice();
}

export function get(id: string): Note | undefined {
  return cache.find(n => n.id === id);
}

export function getOpen(): Note[] {
  return cache.filter(n => n.open);
}

export function create(icon: string): Note {
  const now = Date.now();
  const note: Note = {
    id: `n_${now.toString(36)}_${(seq++).toString(36)}`,
    icon,
    body: '',
    open: false,
    x: -1,
    y: -1,
    w: -1,
    h: -1,
    collapsed: false,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  cache.unshift(note);
  scheduleSave();
  notify();
  return note;
}

export function update(id: string, patch: Partial<Note>): void {
  const n = cache.find(x => x.id === id);
  if (!n) return;
  Object.assign(n, patch, {updatedAt: Date.now()});
  scheduleSave();
  notify();
}

/** Geometry updates skip the notify() (drag is native; no React re-render needed). */
export function setGeometry(id: string, x: number, y: number): void {
  const n = cache.find(x2 => x2.id === id);
  if (!n) return;
  n.x = x;
  n.y = y;
  scheduleSave();
}

/** Persist a resize (no notify — the Manager doesn't render window size). */
export function setSize(id: string, w: number, h: number): void {
  const n = cache.find(x2 => x2.id === id);
  if (!n) return;
  n.w = w;
  n.h = h;
  scheduleSave();
}

export function setOpen(id: string, open: boolean): void {
  update(id, {open});
}

export function remove(id: string): void {
  cache = cache.filter(n => n.id !== id);
  scheduleSave();
  notify();
}

// ---- Derived views ------------------------------------------------------

export function title(n: Note): string {
  const first = n.body.split('\n').find(l => l.trim().length > 0);
  return first ? first.trim() : 'Untitled';
}

export function preview(n: Note): string {
  const lines = n.body.split('\n');
  // Drop the title line from the preview so it isn't shown twice on the card.
  const firstIdx = lines.findIndex(l => l.trim().length > 0);
  const rest = lines.slice(firstIdx + 1).join('\n').trim();
  return rest || (n.body.trim() ? '' : '(empty)');
}

export function toCardPayload(n: Note): CardPayload {
  return {
    id: n.id,
    icon: n.icon,
    body: n.body,
    x: n.x,
    y: n.y,
    w: n.w ?? -1,
    h: n.h ?? -1,
    collapsed: !!n.collapsed,
    fontSize: fontSp(),
  };
}

// ---- Export / import (to the VISIBLE folder) ----------------------------

function safeName(n: Note): string {
  return title(n).replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'note';
}

/** Write every note as its own .txt in the visible export folder. */
export async function exportAllTxt(): Promise<number> {
  await StickyNative?.ensureDir(EXPORT_DIR);
  let n = 0;
  for (const note of cache) {
    await StickyNative?.writeFile(`${EXPORT_DIR}/${safeName(note)}.txt`, note.body);
    n++;
  }
  return n;
}

/** Dump the whole notes set to a single .json backup in the visible folder. */
export async function exportJson(): Promise<string> {
  await StickyNative?.ensureDir(EXPORT_DIR);
  await StickyNative?.writeFile(JSON_BACKUP, JSON.stringify(cache, null, 2));
  return JSON_BACKUP;
}

/** Restore notes from the .json backup (replaces the current set). */
export async function importJson(): Promise<number> {
  const raw = (await StickyNative?.readTextFile(JSON_BACKUP)) ?? '';
  if (!raw) throw new Error(`No backup at ${JSON_BACKUP}`);
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error('Backup is not a notes list');
  cache = arr as Note[];
  await flush(); // persist to the private data file immediately
  notify();
  return cache.length;
}
