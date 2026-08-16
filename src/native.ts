/**
 * Typed access to the StickyNative bridge (overlay bubble + cards + files).
 */
import {NativeModules} from 'react-native';

export interface CardPayload {
  id: string;
  icon: string;
  body: string;
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
  fontSize: number; // sp
  labels: string[]; // shown as chips in the card header (display only)
  font: string; // font file path from MyStyle/fonts, or '' for system default
}

interface StickyNativeType {
  checkPermission(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  showBubble(): Promise<boolean>;
  hideBubble(): Promise<boolean>;
  syncCards(cards: CardPayload[]): Promise<boolean>;
  hideAllCards(): Promise<boolean>;
  beginEdit(id: string): Promise<boolean>;
  bringToFront(id: string): Promise<boolean>;
  clearAll(): Promise<number>;
  writeFile(path: string, content: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  ensureDir(path: string): Promise<boolean>;
  clipboardSet(text: string): Promise<boolean>;
  clipboardGet(): Promise<string>;
  listFonts(): Promise<Array<{name: string; path: string}>>;
  cleanupOldVersions(dirPath: string): Promise<{freed: number; kept: string}>;
  appendLog(text: string): Promise<boolean>;
}

export const StickyNative: StickyNativeType | undefined =
  NativeModules.StickyNative;

export const MAX_CARDS = 8;

/**
 * Data files (notes.json, settings.json) live in the plugin's PRIVATE, hidden
 * data dir (resolved at runtime via NativePluginManager.getPluginDirPath), so
 * they are NOT exposed to cloud sync / corruption. Exports (.txt and the .json
 * backup) go to a VISIBLE folder the user can reach and back up.
 */
export const EXPORT_DIR = '/storage/emulated/0/MyStyle/Plugins/SuperStickyNote';
export const JSON_BACKUP = `${EXPORT_DIR}/SuperStickyNote-notes.json`;
/** Pre-0.4 VISIBLE data location — migrated away from on first launch. */
export const LEGACY_DIR = '/storage/emulated/0/MyStyle/Plugin/SuperStickyNote';

export function blog(msg: string): void {
  const t = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  StickyNative?.appendLog?.(
    `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())} ${msg}`,
  ).catch(() => {});
}
