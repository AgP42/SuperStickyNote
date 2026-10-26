/**
 * notes.json store — single source of truth for every post-it.
 * Persisted to the plugin's PRIVATE hidden data dir (getPluginDirPath), so cloud
 * sync can't corrupt it. Export/import round-trips to a visible .json backup.
 * In-memory cache with a debounced atomic write; one writer here.
 */
import {NativePluginManager} from 'sn-plugin-lib';

import {DEFAULT_ICON, OLD_DEFAULT_ICON} from './icons';
import {
  StickyNative,
  MAX_CARDS,
  EXPORT_DIR,
  JSON_BACKUP,
  INK_BACKUP_DIR,
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
  // Backlink to where the note was captured (e.g. lasso→OCR): tap "Go to source"
  // to jump/open that file at that page. Absent on manually-created notes.
  sourceFile?: string;
  // The RAW value from getCurrentPageNum: 0-based, and shared with jumpToPage /
  // openFile, so it round-trips untouched. Add 1 only to DISPLAY it.
  sourcePage?: number;
  // Which app the capture came from: a NOTE lasso, or a DOC/PDF text selection.
  // Absent on notes made before 1.3 and on manually-created ones.
  sourceKind?: 'note' | 'doc';
  // Typed text or handwriting, set at creation by the Mode setting. Absent on
  // notes made before 3.0: those show whatever they hold (see cardKind).
  kind?: NoteMode;
  // The lassoed handwriting itself, kept as native ink: `sticker` goes back on a
  // page with insertSticker, `png` is its picture on the card and in the Manager.
  // Both live in the private data dir. Absent on typed and text-only captures.
  ink?: Ink;
  // What was written with the pen IN the card: `strokes` is the vector JSON the
  // card draws from, `png` its picture for the Manager. Private data dir.
  drawing?: Drawing;
  // A handwritten note just made (bubble, Manager) and never written on yet.
  // Only such a note is discarded when left empty: an old note erased to
  // nothing keeps its labels, title and source.
  fresh?: boolean;
}

export interface Drawing {
  strokes: string;
  png: string;
  w: number; // png px
  h: number;
}

export interface Ink {
  sticker: string;
  png: string;
  w: number; // png px
  h: number;
  // 3.0: the capture's strokes are also the note's drawing, which the card
  // shows (and lets you erase). The sticker is then kept only to put the
  // capture back on the page as real strokes, and goes once the drawing is
  // changed.
  inDrawing?: boolean;
}

/**
 * Settings → Mode: what new sticky notes are. Handwriting ('ink'): the bubble
 * opens a card to write on with the pen, a lasso keeps the ink. Text: the
 * keyboard, and a lasso is recognised (OCR). A PDF text selection is text
 * either way.
 */
export type NoteMode = 'ink' | 'text';
export const NOTE_MODES: NoteMode[] = ['ink', 'text'];

let cache: Note[] = [];
let fontKey: FontKey = 'M';
let fontSel = 'sans'; // 'sans' | 'serif' | 'mono' | a MyStyle/fonts path
let bubbleHidden = false; // hide the ✚ launcher bubble
/** Thin solid box drawn on the note around lasso→OCR'd text: off, or its colour. */
export type FrameStyle = 'off' | 'black' | 'grey1' | 'grey2';
export const FRAME_STYLES: FrameStyle[] = ['off', 'black', 'grey1', 'grey2'];
let frameStyle: FrameStyle = 'off';
let mode: NoteMode = 'text';
/** How many sticky notes the user allows on screen at once (1…MAX_CARDS). */
let maxCards = 8;
export const DEFAULT_MAX_CARDS = 8;
/** Past this many, the overlay windows start to tell on the device. */
export const SAFE_MAX_CARDS = 8;
let loaded = false;
let notesPath = '';
let inkPath = '';
let settingsPath = '';
/**
 * `fromCard` = the change was typed in the floating card itself, so the native
 * side is ALREADY up to date: re-syncing it would push a (by then stale) body
 * back into the EditText the user is typing in. Subscribers use it to skip the
 * native card sync while still re-rendering the Manager.
 */
export interface NotifyOpts {
  fromCard?: boolean;
  /**
   * The floating cards are ALREADY right (or unconcerned): re-render the
   * Manager, but skip the native card sync. Used by the Manager's own text
   * editor — syncing per keystroke pushed a full payload for every open card
   * across the bridge and repainted each overlay.
   */
  quiet?: boolean;
}
type Listener = (opts?: NotifyOpts) => void;
const listeners = new Set<Listener>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

function notify(opts?: NotifyOpts): void {
  listeners.forEach(l => {
    try {
      l(opts);
    } catch {}
  });
}

export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function initStore(): Promise<void> {
  if (loaded) return;
  // Private, hidden data dir (not cloud-synced). If getPluginDirPath is
  // unavailable, fall back to the host's PRIVATE files dir — NEVER a MyStyle
  // path: MyStyle is cloud-synced, and writing notes.json there would expose it
  // to sync corruption and leak note contents off-device.
  let dataDir = '';
  try {
    dataDir = (await NativePluginManager.getPluginDirPath()) || '';
  } catch {}
  if (!dataDir) {
    try {
      const filesDir = (await StickyNative?.getFilesDir()) || '';
      if (filesDir) dataDir = `${filesDir}/superstickynote`;
    } catch {}
  }
  // Last resort: the pluginhost's private files dir by its known path — still
  // app-private (never cloud-synced), unlike the old MyStyle fallback.
  if (!dataDir) {
    dataDir = '/data/data/com.ratta.supernote.pluginhost/files/superstickynote';
    blog('[store] WARN: no plugin/files dir — using hardcoded private fallback');
  }
  notesPath = `${dataDir}/notes.json`;
  settingsPath = `${dataDir}/settings.json`;
  inkPath = `${dataDir}/ink`;
  try {
    await StickyNative?.ensureDir(inkPath);
    await StickyNative?.setInkDir(inkPath);
  } catch {}

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
    for (const n of cache) if (n && n.icon === OLD_DEFAULT_ICON) n.icon = DEFAULT_ICON;
    // Handwritten notes made and never written on (the plugin went away
    // before they were closed): nothing to keep.
    const before = cache.length;
    cache = cache.filter(n => !(n && isUnused(n)));
    if (cache.length !== before) {
      blog(`[store] ${before - cache.length} unused handwritten note(s) dropped`);
      scheduleSave();
    }
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
    if (s && typeof s.maxCards === 'number') maxCards = clampMax(s.maxCards);
    if (s && typeof s.frameStyle === 'string' && FRAME_STYLES.includes(s.frameStyle)) {
      frameStyle = s.frameStyle;
    } else if (s && (s.frameOnCapture === true || typeof s.frameStyle === 'string')) {
      frameStyle = 'black'; // migrate the pre-1.0 boolean / earlier solid|dashed|fill
    }
    if (s && NOTE_MODES.includes(s.mode)) mode = s.mode;
    else if (s && s.captureMode === 'ink') mode = 'ink'; // the 2.1 capture setting
  } catch {}
  loaded = true;
}

// ---- Settings (global) --------------------------------------------------

function saveSettings(): void {
  StickyNative?.writeFile(
    settingsPath,
    JSON.stringify({fontKey, font: fontSel, bubbleHidden, frameStyle, maxCards, mode}),
  ).catch(() => {});
}

// ---- How many sticky notes may float at once -----------------------------

function clampMax(n: number): number {
  if (!isFinite(n)) return DEFAULT_MAX_CARDS;
  return Math.max(1, Math.min(MAX_CARDS, Math.round(n)));
}

export function getMaxCards(): number {
  return maxCards;
}

/** Set the user's on-screen maximum. Lowering it never closes what is open. */
export function setMaxCards(n: number): void {
  maxCards = clampMax(n);
  saveSettings();
  notify({quiet: true});
}

// ---- Frame-on-capture (mark captured text on the note) --------------------

export function getFrameStyle(): FrameStyle {
  return frameStyle;
}

export function setFrameStyle(s: FrameStyle): void {
  frameStyle = s;
  saveSettings();
  notify({quiet: true});
}

// ---- Mode: what new sticky notes are --------------------------------------

export function getMode(): NoteMode {
  return mode;
}

export function setMode(m: NoteMode): void {
  mode = m;
  saveSettings();
  notify({quiet: true});
}

/** How a card shows a note: its kind, or 'mixed' for a pre-3.0 note holding ink. */
export function cardKind(n: Note): NoteMode | 'mixed' {
  if (n.kind) return n.kind;
  return n.ink || n.drawing ? 'mixed' : 'text';
}

/** Private folder for captured ink (.sticker + .png), created on demand. */
export async function inkDir(): Promise<string> {
  await StickyNative?.ensureDir(inkPath);
  return inkPath;
}

/** Only files in OUR ink folder are ever deleted: an imported backup can point anywhere. */
function deleteInkFile(f: string | undefined): void {
  if (f && inkPath && f.startsWith(`${inkPath}/`)) {
    StickyNative?.deleteFile(f).catch(() => {});
  }
}

/**
 * The card saved (or emptied) its drawing. The PNG gets a new name on every
 * save, because the Manager's Image caches by URI; the old one goes.
 */
export function setDrawing(id: string, d: Drawing | undefined): void {
  const n = cache.find(x => x.id === id);
  if (!n) return;
  const old = n.drawing;
  if (old?.png && old.png !== d?.png) deleteInkFile(old.png);
  if (old?.strokes && !d) deleteInkFile(old.strokes);
  // A capture whose strokes were changed in the card is no longer what the
  // sticker holds: drop the sticker, the drawing is the note now.
  const ink = n.ink?.inDrawing ? undefined : n.ink;
  if (n.ink?.inDrawing) {
    deleteInkFile(n.ink.sticker);
    deleteInkFile(n.ink.png);
  }
  // fromCard: the card already shows it, no need to sync it back.
  update(id, {drawing: d, ink, ...(d ? {fresh: false} : {})}, {fromCard: true});
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

export function getOpen(): Note[] {
  return cache.filter(n => n.open);
}

/** A new note, of the current Mode unless `kind` says otherwise (a PDF text selection). */
export function create(icon: string, kind: NoteMode = mode): Note {
  const now = Date.now();
  const note: Note = {
    id: `n_${now.toString(36)}_${(seq++).toString(36)}`,
    icon,
    kind,
    ...(kind === 'ink' ? {fresh: true} : {}),
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

export function update(id: string, patch: Partial<Note>, opts?: NotifyOpts): void {
  const n = cache.find(x => x.id === id);
  if (!n) return;
  Object.assign(n, patch, {updatedAt: Date.now()});
  scheduleSave();
  notify(opts);
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
  const n = cache.find(x => x.id === id);
  // Put away without anything on it (Hide, in the Manager): not worth keeping.
  if (!open && n && isUnused(n)) {
    remove(id);
    return;
  }
  update(id, {open});
}

/** Close every open sticky in ONE store change, so the cards sync once. */
export function closeAll(): void {
  let changed = false;
  const before = cache.length;
  cache = cache.filter(n => !(n.open && isUnused(n)));
  if (cache.length !== before) changed = true;
  for (const n of cache) {
    if (n.open) {
      n.open = false; // not an edit: updatedAt is the note's date in the list
      changed = true;
    }
  }
  if (!changed) return;
  scheduleSave();
  notify();
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

/** A handwritten note made and left without anything on it — not worth keeping. */
export function isUnused(n: Note): boolean {
  return (
    !!n.fresh &&
    n.kind === 'ink' &&
    !n.drawing &&
    !n.ink &&
    !n.body.trim() &&
    !(n.labels && n.labels.length)
  );
}

export function remove(id: string): void {
  const gone = cache.find(n => n.id === id);
  cache = cache.filter(n => n.id !== id);
  for (const f of [gone?.ink?.sticker, gone?.ink?.png, gone?.drawing?.strokes, gone?.drawing?.png]) {
    deleteInkFile(f);
  }
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
  return first ? first.trim() : n.ink || n.drawing ? 'Handwritten note' : 'Untitled';
}

export function preview(n: Note): string {
  const lines = n.body.split('\n');
  // Drop the title line from the preview so it isn't shown twice on the card.
  const firstIdx = lines.findIndex(l => l.trim().length > 0);
  const rest = lines.slice(firstIdx + 1).join('\n').trim();
  return rest || (n.body.trim() || n.ink || n.drawing ? '' : '(empty)');
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
    ink: n.ink && !n.ink.inDrawing ? n.ink.png : '',
    drawing: n.drawing?.strokes || '',
    kind: cardKind(n),
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
    // Text files of text: a handwritten note has none (its body is a title).
    if (note.kind === 'ink' || !note.body.trim()) continue;
    const base = baseName(note);
    const seen = used.get(base) || 0;
    used.set(base, seen + 1);
    const name = seen === 0 ? base : `${base} (${seen + 1})`;
    await StickyNative?.writeFile(`${EXPORT_DIR}/${name}.txt`, note.body);
    n++;
  }
  return n;
}

/** A note's handwriting files (captures and what was written in the card). */
function inkFilesOf(n: Note): string[] {
  return [n.ink?.sticker, n.ink?.png, n.drawing?.strokes, n.drawing?.png].filter(
    (f): f is string => !!f,
  );
}

const fileName = (f: string) => f.slice(f.lastIndexOf('/') + 1);

/**
 * Dump the whole notes set to a single .json backup in the visible folder,
 * with their handwriting copied into the folder next to it.
 */
export async function exportJson(): Promise<string> {
  await StickyNative?.ensureDir(EXPORT_DIR);
  await StickyNative?.ensureDir(INK_BACKUP_DIR);
  let copied = 0;
  const keep: string[] = [];
  for (const n of cache) {
    for (const f of inkFilesOf(n)) {
      keep.push(fileName(f));
      try {
        if (await StickyNative?.copyFile(f, `${INK_BACKUP_DIR}/${fileName(f)}`)) copied++;
      } catch (e) {
        blog(`[export] copy ${f} failed: ${(e as Error)?.message}`);
      }
    }
  }
  await StickyNative?.writeFile(JSON_BACKUP, JSON.stringify(cache, null, 2));
  // The backup is a snapshot: handwriting no note uses any more goes.
  let pruned = 0;
  try {
    pruned = (await StickyNative?.pruneDir(INK_BACKUP_DIR, keep)) || 0;
  } catch (e) {
    blog(`[export] prune failed: ${(e as Error)?.message}`);
  }
  blog(`[export] ${cache.length} notes, ${copied} handwriting files, ${pruned} old ones removed`);
  return JSON_BACKUP;
}

/**
 * A backed-up note's handwriting file, back into our ink folder when it isn't
 * on this device any more (another device, or the note was deleted).
 */
async function restoreInkFile(f: string | undefined): Promise<string | undefined> {
  if (!f) return f;
  try {
    if (await StickyNative?.fileExists(f)) return f;
    const to = `${inkPath}/${fileName(f)}`;
    if (await StickyNative?.copyFile(`${INK_BACKUP_DIR}/${fileName(f)}`, to)) return to;
  } catch (e) {
    blog(`[import] restore ${f} failed: ${(e as Error)?.message}`);
  }
  return f;
}

/**
 * Merge notes from the .json backup into the current set — **non-destructive**.
 * Existing notes are kept as-is; only notes whose id isn't already present are
 * added (imported as closed, so they don't blow the on-screen limit). Returns
 * how many were added.
 */
export async function importJson(): Promise<number> {
  let raw = '';
  try {
    raw = (await StickyNative?.readTextFile(JSON_BACKUP)) ?? '';
  } catch (e) {
    blog(`[import] readTextFile threw: ${(e as Error)?.message}`);
    throw new Error(`Read failed: ${(e as Error)?.message}`);
  }
  blog(`[import] read ${JSON_BACKUP} → ${raw.length} bytes`);
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
    if (n.ink) {
      n.ink = {...n.ink, sticker: (await restoreInkFile(n.ink.sticker)) || '', png: (await restoreInkFile(n.ink.png)) || ''};
    }
    if (n.drawing) {
      n.drawing = {
        ...n.drawing,
        strokes: (await restoreInkFile(n.drawing.strokes)) || '',
        png: (await restoreInkFile(n.drawing.png)) || '',
      };
    }
    cache.push({...n, open: false}); // add to the list, don't auto-float
    added++;
  }
  await flush();
  notify();
  return added;
}
