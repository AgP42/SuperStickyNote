/**
 * Put a sticky back ON the page: its text goes in as an editable text box, its
 * handwriting as native ink, on whatever note page is displayed under the Manager.
 *
 * This is the round trip SuperStickyNote never had — capture was one-way. It is
 * NOT a clipboard paste: since Android 10 an app may only read the system
 * clipboard while it holds window focus, and our code runs in the pluginhost
 * process while the focused window belongs to the note app, so getPrimaryClip()
 * always comes back empty. The SDK's own insert path has no such restriction.
 *
 * Handwriting goes on a notebook or a document page; a text box only on a
 * notebook page — on a PDF the firmware refuses insertText ("This app is not
 * allowed to use this API", code 102, device 2026-10-25). insertText targets
 * the CURRENTLY displayed page.
 *
 * Two firmware traps, both learned the hard way in SuperDashboard's paste:
 *  1. a freshly inserted text box renders at a tiny default size until the first
 *     relayout — which is why moving it by hand used to "fix" it. modifyElements
 *     is the programmatic equivalent of that move, so we write it straight back.
 *  2. the firmware RE-FITS the text to fill its box on that relayout, landing on
 *     fontSize = boxHeight / (5/3 * lines). An oversized box therefore inflates
 *     the font. Size the box snugly and the re-fit reproduces what we asked for.
 */
import {PluginCommAPI, PluginFileAPI, PluginNoteAPI} from 'sn-plugin-lib';

import {StickyNative, blog} from './native';
import {insertStrokesIntoNote} from './pastestrokes';
import {fontSp, getFont, Note} from './store';

/** Unwrap the SDK's APIResponse shape. */
function un<T>(r: any): T | undefined {
  return r && r.success ? (r.result as T) : undefined;
}

/** Saving is best-effort everywhere: never let a failed save abort an insert. */
const save = () => PluginNoteAPI.saveCurrentNote().catch(() => {});

/** Page units of the standard note page, used when the display size is unknown. */
const PAGE_W = 1404;
const PAGE_H = 1872;
/**
 * The Settings text size is in sp, for the floating card; a page text box is in
 * page units. 96 page units is the firmware's comfortable body size and our "M"
 * is 18 sp, so one sp is worth 96/18 of a page unit. The whole scale follows:
 * XS 64 · S 75 · M 96 · L 128 · XL 160 · XXL 203.
 */
const PAGE_UNITS_PER_SP = 96 / 18;

/** Text size and typeface for the page, taken from Settings — no new knobs. */
function pageFont(): {fontSize: number; fontPath: string} {
  const sel = getFont();
  return {
    fontSize: Math.round(fontSp() * PAGE_UNITS_PER_SP),
    // Only a real font FILE can be handed to the firmware. 'sans' / 'serif' /
    // 'mono' are RN family names with no path, so those fall back to the note's
    // own default font.
    fontPath: sel && sel.startsWith('/') ? sel : '',
  };
}
/** Box height one line consumes, per unit of fontSize — the firmware's own ratio. */
const LINE = 5 / 3;

export interface InsertResult {
  ok: boolean;
  why?: string;
  // ok, but some of it could not go down: why.
  partial?: string;
}

/** The open file, when it can take `what`: ink on a notebook or a document, text on a notebook. */
async function currentPage(what: 'ink' | 'text'): Promise<{path?: string; why?: string}> {
  let path: string | undefined;
  try {
    path = un<string>(await PluginCommAPI.getCurrentFilePath());
  } catch (e) {
    blog(`[tonote] getCurrentFilePath failed: ${(e as Error)?.message}`);
  }
  if (!path) return {why: 'Open a notebook or a document first'};
  if (!/\.(note|pdf|epub)$/i.test(path)) return {why: 'Open a notebook or a document first'};
  const doc = path.match(/\.(pdf|epub)$/i);
  if (what === 'text' && doc) {
    const kind = doc[1].toUpperCase();
    return {why: `No text box on a ${kind}: only handwriting can be put on a ${kind}`};
  }
  return {path};
}

/**
 * Put a handwritten sticky back on the displayed page.
 *
 * A capture nobody changed goes back as native ink (insertSticker): real
 * strokes again, which can be lassoed, moved or converted like any other
 * writing; the firmware chooses where it lands. Anything written or erased in
 * the card is rebuilt as strokes and goes in the same way (pastestrokes.ts).
 */
export async function insertInkIntoNote(note: Note): Promise<InsertResult> {
  const sticker = note.ink?.sticker;
  // The strokes are what gets pasted; the PNG is only their preview.
  const drawing = note.drawing?.strokes;
  if (!sticker && !drawing) return {ok: false, why: 'No handwriting in this sticky note'};
  const {path, why} = await currentPage('ink');
  if (!path) return {ok: false, why};
  let any = false;
  let failed: InsertResult | null = null;
  if (sticker) {
    const r = await insertSticker(sticker, path);
    if (r.ok) {
      any = true;
      // The capture IS the drawing (3.0): nothing more to put down.
      if (note.ink?.inDrawing) return r;
    } else {
      failed = r;
    }
    // Sticker gone (a backup restored elsewhere…): the strokes still go down.
  }
  if (drawing) {
    const r = await insertStrokesIntoNote(note, path);
    if (r.ok) any = true;
    else failed = failed || r;
  }
  if (any) return failed ? {ok: true, partial: failed.why || 'failed'} : {ok: true};
  return failed || {ok: false, why: 'Nothing to put on the page'};
}

/**
 * "Put on page": the note's handwriting if it has some, otherwise its text.
 * Never both: on a note from before 3.0 the text is the OCR of that same
 * handwriting (the note screen offers it on its own). The card's button and
 * the Manager's both come here.
 */
export async function pasteNote(note: Note): Promise<InsertResult & {what: string}> {
  if (note.ink || note.drawing) return {...(await insertInkIntoNote(note)), what: 'Handwriting'};
  if (note.kind === 'ink' || !(note.body || '').trim()) {
    return {ok: false, why: 'This sticky note is empty', what: ''};
  }
  return {...(await insertIntoNote(note)), what: 'Text'};
}

async function insertSticker(sticker: string, path: string): Promise<InsertResult> {
  try {
    if (!(await StickyNative?.fileExists(sticker))) {
      return {ok: false, why: 'Handwriting file is missing on this device'};
    }
  } catch {}
  try {
    const r: any = await PluginCommAPI.insertSticker(sticker);
    if (!(r === true || (r && r.success && r.result !== false))) {
      const msg = (r && r.error && r.error.message) || 'insertSticker refused';
      blog(`[tonote] insertSticker failed: ${msg}`);
      return {ok: false, why: msg};
    }
    await save();
    blog(`[tonote] inserted ink ${sticker} into ${path}`);
    return {ok: true};
  } catch (e) {
    blog(`[tonote] ink err: ${(e as Error)?.message}`);
    return {ok: false, why: (e as Error)?.message};
  }
}

export async function insertIntoNote(note: Note): Promise<InsertResult> {
  const text = (note.body || '').trim();
  if (!text) return {ok: false, why: 'This sticky note is empty'};

  const {path, why} = await currentPage('text');
  if (!path) return {ok: false, why};

  let pageW = PAGE_W;
  let pageH = PAGE_H;
  try {
    const size = un<any>(await PluginCommAPI.getPageDisplaySize());
    if (size && size.width > 0 && size.height > 0) {
      pageW = size.width;
      pageH = size.height;
    }
  } catch {}

  // Snug box, centred on the page: wide enough to read, never wider than the
  // page's margins, never taller than the page itself.
  const {fontSize, fontPath} = pageFont();
  const w = Math.min(pageW - 200, 1000);
  const perLine = Math.max(8, Math.floor(w / (fontSize * 0.55)));
  const lines = Math.max(
    1,
    text
      .split('\n')
      .reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / perLine)), 0),
  );
  const h = Math.min(Math.round(lines * fontSize * LINE), pageH - 40);
  const left = Math.max(20, Math.round((pageW - w) / 2));
  const top = Math.max(20, Math.round((pageH - h) / 2));
  const textRect = {left, top, right: left + w, bottom: top + h};

  try {
    const r: any = await PluginNoteAPI.insertText({
      textContentFull: text,
      textRect,
      fontSize,
      ...(fontPath ? {fontPath} : {}),
      textAlign: 0,
      textFrameWidthType: 0,
      textFrameStyle: 0,
      textEditable: 0,
    });
    if (!(r && r.success)) {
      const msg = (r && r.error && r.error.message) || 'insertText refused';
      blog(`[tonote] insertText failed on ${path}: ${msg} ${JSON.stringify(r)}`);
      return {ok: false, why: msg};
    }
    // No save() here: the re-commit below rewrites the element straight away,
    // so flushing the whole .note twice costs a full file write for nothing.
    await recommit(path, textRect, fontSize, fontPath);
    blog(`[tonote] inserted ${text.length} chars into ${path} size=${fontSize} font=${fontPath || 'default'}`);
    return {ok: true};
  } catch (e) {
    blog(`[tonote] err: ${(e as Error)?.message}`);
    return {ok: false, why: (e as Error)?.message};
  }
}

/**
 * Read the element back and write it again with the geometry we actually want:
 * that write IS the relayout the fresh text box is waiting for (trap 1 above).
 * Best-effort — a failure here leaves the text on the page, just small.
 */
async function recommit(
  path: string,
  textRect: object,
  fontSize: number,
  fontPath: string,
): Promise<void> {
  try {
    const el: any = un<any>(await PluginFileAPI.getLastElement());
    // 500/501/502 are the text-box element types; anything else isn't ours.
    if (!el || !el.textBox || ![500, 501, 502].includes(el.type)) {
      blog('[tonote] inserted but could not read it back');
      return;
    }
    // A fresh element can report pageNum = -1, and modifyElements rejects a
    // negative page, so fall back to the page actually on screen.
    const page =
      typeof el.pageNum === 'number' && el.pageNum >= 0
        ? el.pageNum
        : un<number>(await PluginCommAPI.getCurrentPageNum()) ?? 0;
    const mr: any = await PluginFileAPI.modifyElements(path, page, [
      {
        ...el,
        pageNum: page,
        layerNum: el.layerNum ?? 0,
        textBox: {
          ...el.textBox,
          textRect,
          fontSize,
          textFrameWidthType: 0,
          ...(fontPath ? {fontPath} : {}),
        },
      },
    ]);
    await save();
    if (!(mr && mr.success)) {
      blog(`[tonote] modifyElements failed${mr && mr.error ? ': ' + mr.error.message : ''}`);
    }
  } catch (e) {
    blog(`[tonote] re-commit failed: ${(e as Error)?.message}`);
  }
}
