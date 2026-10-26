/**
 * Put what was written in a card on the page as real strokes.
 *
 * The lasso route (saveStickerByLasso → insertSticker) only exists for ink
 * that came from a page. Ink written in a card has no sticker, so we build
 * one: a stroke element per card stroke (createElement), filled with our
 * points converted to EMR, turned into a .sticker (convertElement2Sticker) and
 * inserted like a capture. The note then holds native strokes: lasso, move,
 * erase, convert, as with anything written on the page.
 *
 * Card strokes are stored in pad pixels with firmware pen codes (see
 * InkPad / FirmwareInk); the page wants SDK pen codes and EMR points.
 */
import {PluginCommAPI, PluginFileAPI, PluginManager, PointUtils} from 'sn-plugin-lib';

import {StickyNative, blog} from './native';
import {inkDir, Note} from './store';

type Card = {pen: number; w: number; c: number; pts: number[]};

function un<T>(r: any): T | undefined {
  return r && r.success ? (r.result as T) : undefined;
}

/** Firmware pen code → the SDK's (what a stroke on the page carries). */
function sdkPen(fw: number): number {
  return fw === 16 ? 1 : fw;
}

function sdkColor(fw: number): number {
  switch (fw) {
    case -101:
      return 0x9d;
    case -102:
      return 0xc9;
    case 254:
      return 0xfe;
    default:
      return 0;
  }
}

/** Raw pressure on the page is 0..4095; the card keeps 0..1. */
const PRESSURE_MAX = 4095;

export async function insertStrokesIntoNote(
  note: Note,
  path: string,
): Promise<{ok: boolean; why?: string}> {
  const file = note.drawing?.strokes;
  if (!file) return {ok: false, why: 'Nothing written in this sticky note'};
  let strokes: Card[] = [];
  try {
    const raw = await StickyNative?.readTextFile(file);
    const all = JSON.parse(raw || '{}').strokes;
    strokes = (Array.isArray(all) ? all : []).filter(
      (s: any) => s && Array.isArray(s.pts) && s.pts.length >= 3,
    );
  } catch (e) {
    blog(`[paste] reading ${file} failed: ${(e as Error)?.message}`);
  }
  if (!strokes.length) return {ok: false, why: 'Nothing written in this sticky note'};

  // getPageSize is a note-file API: a document can throw there, then the
  // displayed page size stands in (as the lasso capture does).
  let size: {width: number; height: number} | undefined;
  let page = 0;
  try {
    page = un<number>(await PluginCommAPI.getCurrentPageNum()) ?? 0;
    size = un<{width: number; height: number}>(await PluginFileAPI.getPageSize(path, page));
  } catch (e) {
    blog(`[paste] getPageSize failed: ${(e as Error)?.message}`);
  }
  if (!size || !size.width) {
    try {
      size = un<any>(await PluginCommAPI.getPageDisplaySize());
    } catch {}
  }
  if (!size || !size.width) return {ok: false, why: 'Page size unavailable'};
  const W = size.width;
  const H = size.height;
  let maxX: number;
  let maxY: number;
  try {
    maxX = PointUtils.getRealMaxX(size);
    maxY = PointUtils.getRealMaxY(size);
  } catch {
    blog(`[paste] unknown page size ${W}x${H}`);
    return {ok: false, why: 'This page size is not supported yet'};
  }

  // Centre the writing on the page at its size on the card (shrunk to fit).
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i + 1 < s.pts.length; i += 3) {
      x1 = Math.min(x1, s.pts[i]);
      y1 = Math.min(y1, s.pts[i + 1]);
      x2 = Math.max(x2, s.pts[i]);
      y2 = Math.max(y2, s.pts[i + 1]);
    }
  }
  const bw = Math.max(1, x2 - x1);
  const bh = Math.max(1, y2 - y1);
  const k = Math.min(1, (W - 160) / bw, (H * 0.7) / bh);
  const left = (W - bw * k) / 2;
  const top = (H - bh * k) / 2;
  const toEmr = (px: number, py: number) => {
    const x = left + (px - x1) * k;
    const y = top + (py - y1) * k;
    // Inverse of the page's EMR → pixel mapping (rotated 90°, x flipped).
    return {
      x: Math.round(Math.max(0, Math.min(H, y)) / H * maxX),
      y: Math.round((W - Math.max(0, Math.min(W, x))) / W * maxY),
    };
  };

  let machineType = 5;
  try {
    machineType = await PluginManager.getDeviceType();
  } catch {}

  const els: any[] = [];
  const sticker = `${await inkDir()}/paste_${Date.now().toString(36)}.sticker`;
  try {
    for (const s of strokes) {
      const el: any = un<any>(await PluginCommAPI.createElement(0));
      if (!el || !el.stroke) {
        blog('[paste] createElement(0) returned no stroke');
        return {ok: false, why: 'Could not create strokes'};
      }
      els.push(el);
      el.type = 0;
      el.pageNum = page;
      el.layerNum = 0;
      el.maxX = maxX;
      el.maxY = maxY;
      el.thickness = Math.max(1, Math.round((s.w || 1000) * k));
      el.stroke.penType = sdkPen(s.pen);
      el.stroke.penColor = sdkColor(s.c);
      const pts: {x: number; y: number}[] = [];
      const prs: number[] = [];
      for (let i = 0; i + 2 < s.pts.length; i += 3) {
        pts.push(toEmr(s.pts[i], s.pts[i + 1]));
        prs.push(Math.round(Math.max(0.05, Math.min(1, s.pts[i + 2] || 0.5)) * PRESSURE_MAX));
      }
      const okP = await el.stroke.points.setRange(0, 0, pts);
      const okR = await el.stroke.pressures.setRange(0, 0, prs);
      let okF = true;
      try {
        okF = await el.stroke.flagDraw.setRange(0, 0, pts.map(() => true));
      } catch {
        okF = false;
      }
      if (els.length === 1) {
        blog(
          `[paste] stroke 1: pen=${el.stroke.penType} color=${el.stroke.penColor} thickness=${el.thickness} ` +
            `pts=${pts.length} first=${JSON.stringify(pts[0])} set points=${okP} pressures=${okR} flags=${okF}`,
        );
      }
    }
    const cr: any = await PluginCommAPI.convertElement2Sticker({machineType, elements: els, stickerPath: sticker});
    const converted = !!(cr && cr.success && cr.result !== false);
    blog(
      `[paste] convertElement2Sticker(${els.length} strokes, machine ${machineType}, page ${W}x${H}) → ` +
        `${converted ? 'ok' : JSON.stringify(cr)}`,
    );
    if (!converted) return {ok: false, why: (cr && cr.error && cr.error.message) || 'Could not build the strokes'};
    const ir: any = await PluginCommAPI.insertSticker(sticker);
    const inserted = ir === true || !!(ir && ir.success && ir.result !== false);
    blog(`[paste] insertSticker → ${inserted ? 'ok' : JSON.stringify(ir)}`);
    if (!inserted) return {ok: false, why: (ir && ir.error && ir.error.message) || 'insertSticker refused'};
    return {ok: true};
  } catch (e) {
    blog(`[paste] failed: ${(e as Error)?.message}`);
    return {ok: false, why: (e as Error)?.message};
  } finally {
    for (const el of els) {
      try {
        el.recycle && (await el.recycle());
      } catch {}
    }
    // Not at once: the note may still be reading it.
    setTimeout(() => StickyNative?.deleteFile(sticker).catch(() => {}), 60000);
  }
}
