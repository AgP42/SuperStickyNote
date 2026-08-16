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

/** A font from MyStyle/fonts. `path === ''` means the system default. */
export interface FontInfo {
  name: string;
  path: string;
}

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
  labels: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

let cache: Note[] = [];
let fontKey: FontKey = 'M';
let fontSel = 'sans'; // 'sans' | 'serif' | 'mono' | a MyStyle/fonts path
let bubbleHidden = false; // hide the ✚ launcher bubble
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
    if (s && typeof s.font === 'string' && s.font) fontSel = s.font;
    else if (s && typeof s.fontPath === 'string' && s.fontPath) fontSel = s.fontPath; // migrate
    if (s && typeof s.bubbleHidden === 'boolean') bubbleHidden = s.bubbleHidden;
  } catch {}
  loaded = true;
}

// ---- Settings (global) --------------------------------------------------

function saveSettings(): void {
  StickyNative?.writeFile(
    settingsPath,
    JSON.stringify({fontKey, font: fontSel, bubbleHidden}),
  ).catch(() => {});
}

// ---- Bubble (✚ launcher) visibility -------------------------------------

export function getBubbleHidden(): boolean {
  return bubbleHidden;
}

/** Show/hide the launcher bubble and remember it. Applies natively at once. */
export function setBubbleHidden(hidden: boolean): void {
  bubbleHidden = hidden;
  saveSettings();
  (hidden ? StickyNative?.hideBubble() : StickyNative?.showBubble())?.catch(() => {});
  notify();
}

export function getFontKey(): FontKey {
  return fontKey;
}

export function fontSp(): number {
  return FONT_SP[fontKey];
}

export function setFontKey(k: FontKey): void {
  fontKey = k;
  saveSettings();
  notify();
}

export function getFont(): string {
  return fontSel;
}

export function setFont(sel: string): void {
  fontSel = sel;
  saveSettings();
  notify();
}

/** RN fontFamily for a selection (Manager preview). Custom paths → undefined (RN can't load them). */
export function rnFamily(sel: string = fontSel): string | undefined {
  if (sel === 'sans') return 'sans-serif';
  if (sel === 'serif') return 'serif';
  if (sel === 'mono') return 'monospace';
  return undefined;
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
    labels: [],
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

/**
 * Give a not-yet-placed note a cascade position (stepped down-right from the
 * other open notes) so successive post-its fan out instead of stacking exactly.
 * No-op once the note has a real position (created earlier / dragged).
 */
export function placeForOpen(id: string): void {
  const n = cache.find(m => m.id === id);
  if (!n || (n.x >= 0 && n.y >= 0)) return;
  const slot = cache.filter(m => m.open && m.id !== id).length % 8;
  const STEP = 60;
  n.x = 60 + slot * STEP;
  n.y = 150 + slot * STEP;
  scheduleSave();
}

export function remove(id: string): void {
  cache = cache.filter(n => n.id !== id);
  scheduleSave();
  notify();
}

/** Every distinct label used across notes, sorted. */
export function allLabels(): string[] {
  const s = new Set<string>();
  for (const n of cache) for (const l of n.labels || []) s.add(l);
  return Array.from(s).sort((a, b) => a.localeCompare(b));
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
    labels: n.labels || [],
    font: fontSel,
  };
}

// ---- Export / import (to the VISIBLE folder) ----------------------------

function safeName(n: Note): string {
  return title(n).replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'Untitled';
}

/** Creation date+time — the discriminator so same-title notes don't overwrite. */
function stamp(n: Note): string {
  const d = new Date(n.createdAt || Date.now());
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

/** "<title> - <date time>" — unique enough that identical titles stay distinct. */
function baseName(n: Note): string {
  return `${safeName(n)} - ${stamp(n)}`;
}

/** Export a single note; returns the file path. */
export async function exportOneTxt(note: Note): Promise<string> {
  await StickyNative?.ensureDir(EXPORT_DIR);
  const path = `${EXPORT_DIR}/${baseName(note)}.txt`;
  await StickyNative?.writeFile(path, note.body);
  return path;
}

/** Write every note as its own .txt, de-duplicating any exact name clash. */
export async function exportAllTxt(): Promise<number> {
  await StickyNative?.ensureDir(EXPORT_DIR);
  const used = new Map<string, number>();
  let n = 0;
  for (const note of cache) {
    const base = baseName(note);
    const seen = used.get(base) || 0;
    used.set(base, seen + 1);
    const name = seen === 0 ? base : `${base} (${seen + 1})`;
    await StickyNative?.writeFile(`${EXPORT_DIR}/${name}.txt`, note.body);
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

/**
 * Merge notes from the .json backup into the current set — **non-destructive**.
 * Existing notes are kept as-is; only notes whose id isn't already present are
 * added (imported as closed, so they don't blow the on-screen limit). Returns
 * how many were added.
 */
export async function importJson(): Promise<number> {
  const raw = (await StickyNative?.readTextFile(JSON_BACKUP)) ?? '';
  if (!raw) throw new Error(`No backup at ${JSON_BACKUP}`);
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error('Backup is not a notes list');
  const existing = new Set(cache.map(n => n.id));
  let added = 0;
  for (const n of arr as Note[]) {
    if (!n) continue;
    if (!n.id) n.id = `n_imp_${Date.now().toString(36)}_${(seq++).toString(36)}`;
    if (existing.has(n.id)) continue; // never overwrite an existing note
    existing.add(n.id);
    cache.push({...n, open: false}); // add to the list, don't auto-float
    added++;
  }
  await flush();
  notify();
  return added;
}
