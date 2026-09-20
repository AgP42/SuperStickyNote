/**
 * SuperStickyNote — floating quick-note post-its for Supernote.
 *  - Launcher bubble (✚) floats everywhere; tap → new floating note.
 *  - Toolbar button → the Manager (list / new / actions).
 *  - Each open note is a native floating card over the canvas (max 8).
 *
 * All native→JS events are handled HERE, at module scope: module-level
 * listeners survive plugin-view close; component listeners do not.
 * @format
 */
import {AppRegistry, DeviceEventEmitter, Image, ToastAndroid} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager, PluginCommAPI, PluginDocAPI, PluginFileAPI} from 'sn-plugin-lib';
import {StickyNative, blog} from './src/native';
import {DEFAULT_ICON} from './src/icons';
import {
  initStore,
  create,
  update,
  setOpen,
  setGeometry,
  setSize,
  placeForOpen,
  getMaxCards,
  getOpen,
  toCardPayload,
  getBubbleHidden,
  getFrameStyle,
  flush,
} from './src/store';
import {ensureFilePermissions} from './src/permissions';
import {detectUnderlineLabels} from './src/underline';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

// ---- Overlay orchestration ------------------------------------------------

let hasPermission = false;

async function refreshPermission() {
  try {
    hasPermission = (await StickyNative?.checkPermission()) === true;
  } catch {
    hasPermission = false;
  }
  return hasPermission;
}

/**
 * Last body revision received from each native card. Echoed back on every sync
 * so the card can recognise — and ignore — a payload that is just a late echo
 * of what the user is typing right now.
 */
const cardRev = new Map();

/** Reflect the store's open notes onto the native cards. */
async function syncOpenCards() {
  if (!hasPermission) return;
  try {
    const open = getOpen();
    const live = new Set(open.map(n => n.id));
    for (const id of cardRev.keys()) {
      if (!live.has(id)) cardRev.delete(id); // its native Card is gone with its rev
    }
    await StickyNative?.syncCards(
      open.map(n => ({...toCardPayload(n), rev: cardRev.get(n.id) ?? -1})),
    );
  } catch (e) {
    blog(`[cards] sync failed: ${e && e.message}`);
  }
}

/** Restore the on-canvas world (cards + bubble) — used when the view leaves. */
async function restoreOverlay() {
  if (!hasPermission) return;
  await syncOpenCards();
  try {
    // Respect the user's Configuration → Bubble setting.
    if (getBubbleHidden()) await StickyNative?.hideBubble();
    else await StickyNative?.showBubble();
  } catch (e) {
    blog(`[bub] restore failed: ${e && e.message}`);
  }
}

// NOTE: we deliberately do NOT tie the overlay to AppState. Opening the soft
// keyboard (or a focusable post-it) flips AppState to 'active' even though the
// Manager isn't open — that spurious "active" was hiding the card we'd just
// created, which only reappeared on the next create (device log 2026-08-15).
// Instead we hide only when the Manager view actually opens, and restore when
// it closes — both signals we control explicitly below.

// Post-its are system overlays and stay ON TOP of the Manager on purpose: it lets
// the Manager preview fonts/size live and open a note without closing the panel.
/** Reflect store changes onto the visible cards (called live from the Manager). */
global.__ssnSyncCards = syncOpenCards;
/** Restore the on-canvas world (used at boot and when the Manager closes). */
global.__ssnRestoreOverlay = restoreOverlay;

// Called by the Manager after the user grants the overlay permission.
global.__ssnEnableOverlay = async () => {
  await refreshPermission();
  return hasPermission;
};

// ---- Startup --------------------------------------------------------------

(async () => {
  // Chauvet permission model: shared storage (MyStyle legacy dirs, .json backup,
  // fonts, lasso→OCR) is gated behind FILE:READ/WRITE — even raw java.io. Request
  // them before initStore()'s legacy-dir reads so they don't hit a
  // SecurityException. (Separate from the overlay SYSTEM_ALERT_WINDOW below.)
  try {
    const ok = await ensureFilePermissions();
    blog(`[boot] file permissions granted=${ok}`);
  } catch (e) {
    blog(`[boot] ensureFilePermissions failed: ${e && e.message}`);
  }
  await initStore();
  await refreshPermission();
  // Clear stale windows left in the persistent PluginHost process by a previous
  // classloader, THEN restore from the store.
  try {
    await StickyNative?.clearAll();
  } catch {}
  await restoreOverlay();
  blog(`[boot] permission=${hasPermission} open=${getOpen().length}`);
  // Reclaim old plugin versions (PluginHost keeps them all on reinstall).
  try {
    const dir = await PluginManager.getPluginDirPath();
    if (dir) await StickyNative?.cleanupOldVersions(dir);
  } catch {}
})();

// ---- Native → JS events (module scope: survive plugin-view close) ---------

// Bubble tap → create a note, float it, and drop straight into edit mode so
// the keyboard opens on the fresh post-it (no plugin view involved).
DeviceEventEmitter.addListener('onNewNote', async () => {
  if (getOpen().length >= getMaxCards()) {
    ToastAndroid.show(
      `Max ${getMaxCards()} sticky notes on screen — close one first`,
      ToastAndroid.SHORT,
    );
    return; // never drop an existing post-it to make room
  }
  const note = create(DEFAULT_ICON);
  placeForOpen(note.id); // cascade offset so successive post-its fan out
  setOpen(note.id, true);
  try {
    await syncOpenCards();
    await StickyNative?.beginEdit(note.id);
  } catch (e) {
    blog(`[new] err: ${e && e.message}`);
  }
});

// Inline edits stream from the native EditText — persist to the store.
DeviceEventEmitter.addListener('onCardEdited', payload => {
  if (!payload || payload.id == null) return;
  if (typeof payload.rev === 'number') cardRev.set(payload.id, payload.rev);
  update(payload.id, {body: payload.body}, {fromCard: true});
});

DeviceEventEmitter.addListener('onCardClose', payload => {
  const id = payload && payload.id;
  if (!id) return;
  cardRev.delete(id); // a re-opened card starts its revisions from scratch
  setOpen(id, false); // native already removed the card view
});

DeviceEventEmitter.addListener('onCardMoved', payload => {
  if (payload && payload.id) setGeometry(payload.id, payload.x, payload.y);
});

DeviceEventEmitter.addListener('onCardCollapsed', payload => {
  if (payload && payload.id != null) update(payload.id, {collapsed: !!payload.collapsed});
});

DeviceEventEmitter.addListener('onCardResized', payload => {
  if (payload && payload.id) setSize(payload.id, payload.w, payload.h);
});

// ---- Frame drawing on the note (optional, around captured text) -----------
// A single thin fineliner rectangle (one element → draws instantly and is
// erased in one gesture). Native pen colours: 0x00 black, 0x9D dark grey,
// 0xC9 light grey. penWidth schema minimum is 100.
const FRAME_COLOR = {black: 0x00, grey1: 0x9d, grey2: 0xc9};

/** Draw a thin solid box on the note around `rect` in the chosen colour. */
async function drawFrame(rect, style) {
  const penColor = FRAME_COLOR[style];
  if (penColor == null) return; // 'off' or unknown
  try {
    await PluginCommAPI.insertGeometry({
      penColor,
      penType: 10, // fineliner
      penWidth: 200, // schema minimum is 100
      type: 'GEO_polygon',
      points: [
        {x: rect.left, y: rect.top},
        {x: rect.right, y: rect.top},
        {x: rect.right, y: rect.bottom},
        {x: rect.left, y: rect.bottom},
        {x: rect.left, y: rect.top},
      ],
      showLassoAfterInsert: false,
    });
  } catch (e) {
    blog(`[lasso] drawFrame(${style}) failed: ${e && e.message}`);
  }
}

// Human-readable label for one lasso geometry. Shapes carry no text to OCR,
// so a shapes-only selection is noted descriptively instead.
function describeGeometry(g) {
  switch (g && g.type) {
    case 'straightLine':
      return 'Line';
    case 'GEO_circle':
      return 'Circle';
    case 'GEO_ellipse':
      return 'Ellipse';
    case 'GEO_polygon': {
      const pts = Array.isArray(g.points) ? g.points : [];
      // Polygons come back closed (last point repeats the first) → sides = pts − 1.
      let sides = pts.length;
      if (sides >= 2) {
        const a = pts[0];
        const b = pts[sides - 1];
        if (a && b && a.x === b.x && a.y === b.y) sides -= 1;
      }
      if (sides === 3) return 'Triangle';
      if (sides === 4) return 'Rectangle';
      if (sides > 4) return `Polygon (${sides} sides)`;
      return 'Polygon';
    }
    default:
      return 'Shape';
  }
}

// Tally shapes into one body, e.g. "2 × Circle\n1 × Line". Empty → no geometry.
function describeGeometries(geos) {
  if (!geos || geos.length === 0) return '';
  const counts = new Map();
  for (const g of geos) {
    const label = describeGeometry(g);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const parts = [];
  for (const [label, n] of counts) parts.push(n > 1 ? `${n} × ${label}` : label);
  return parts.join('\n');
}

// Lasso → "Add to sticky": OCR the selection and drop it into a new post-it.
async function handleLassoToSticky() {
  try {
    ToastAndroid.show('Recognizing…', ToastAndroid.SHORT);
    // Element reads (getLassoElements/recognizeElements) + getPageSize hit shared
    // storage → gated behind FILE:READ on the preview firmware. Guard here so a
    // first-run OCR before boot's grant doesn't throw a SecurityException.
    await ensureFilePermissions();
    const pathR = await PluginCommAPI.getCurrentFilePath();
    const path = pathR && pathR.success ? pathR.result : null;
    if (!path || !/\.(note|pdf|epub)$/i.test(path)) {
      ToastAndroid.show('Open a note or document to capture', ToastAndroid.SHORT);
      return;
    }
    const isNote = /\.note$/i.test(path);
    // getCurrentPageNum and openFile share the firmware's page space, so the RAW
    // value round-trips with no ±1 — converting here is what puts a backlink one
    // page early.
    const pageR = await PluginCommAPI.getCurrentPageNum();
    const page = pageR && pageR.success ? pageR.result : 1;
    // The recognizer needs the FULL page size (not the lasso rect). getPageSize is
    // a note-file API, so a document falls back to the displayed page size.
    let size = null;
    if (isNote) {
      const sizeR = await PluginFileAPI.getPageSize(path, page);
      size = sizeR && sizeR.success ? sizeR.result : null;
      if (!size) {
        blog(`[lasso] getPageSize(${page}) failed: ${(sizeR && sizeR.error && sizeR.error.message) || 'unknown'}`);
      }
    }
    if (!size || !size.width) {
      try {
        const dR = await PluginCommAPI.getPageDisplaySize();
        if (dR && dR.success && dR.result && dR.result.width > 0) size = dR.result;
      } catch (e) {
        blog(`[lasso] getPageDisplaySize failed: ${e && e.message}`);
      }
    }
    if (!size || !size.width) {
      ToastAndroid.show('Page size unavailable', ToastAndroid.SHORT);
      return;
    }
    blog(`[lasso] path=${path} isNote=${isNote} page=${page} size=${size.width}x${size.height}`);
    const elR = await PluginCommAPI.getLassoElements();
    const els = elR && elR.success ? elR.result : [];
    // Don't bail on empty: a shapes-only selection can return no elements here
    // (geometry is read separately below via getLassoGeometries).
    // Text ALWAYS wins over shapes. A geometry element (line/shape) mixed into
    // the selection can make the recognizer return nothing for the WHOLE lasso,
    // silently dropping real handwriting — so recognize text WITHOUT the shapes.
    // A line beside notes must never suppress the OCR; the shape description is
    // only a fallback for a truly text-less (shape-only) selection.
    const SHAPE_TYPES = new Set([700, 800]); // Element.TYPE_GEO, TYPE_FIVE_STAR
    const textEls = (els || []).filter(e => e && !SHAPE_TYPES.has(e.type));
    // Grab the lasso bounds NOW (before we clear the selection) in case the user
    // enabled a "mark captured text" style below.
    // The frame is a geometry polygon, and a document takes those just fine — it
    // is only TEXT boxes a PDF can't hold. (SuperDashboard draws the same box on a
    // PDF to-do.) So the frame follows the setting everywhere.
    const frameStyle = getFrameStyle();
    let lassoRect = null;
    if (frameStyle !== 'off') {
      try {
        const rr = await PluginCommAPI.getLassoRect();
        if (rr && rr.success) lassoRect = rr.result;
      } catch (e) {
        blog(`[lasso] getLassoRect failed: ${e && e.message}`);
      }
    }
    // Full page size (NOT the lasso rect) or the recognizer throws.
    let text = '';
    if (textEls.length > 0) {
      const recR = await PluginCommAPI.recognizeElements(textEls, size);
      text = recR && recR.success ? (recR.result || '').trim() : '';
    }
    // A clean straight underline under a word turns that word into a label. Costs
    // nothing when there is no such line, and must run while the lasso is still
    // active and before the elements below are recycled.
    let autoLabels = [];
    try {
      autoLabels = await detectUnderlineLabels(size, els || []);
    } catch (e) {
      blog(`[lasso] underline labels failed: ${e && e.message}`);
    }
    // Free native stroke caches for everything we pulled (shapes included).
    for (const e of els) {
      try {
        e && e.recycle && e.recycle();
      } catch {}
    }
    if (!text) {
      // Only now, with no handwriting to show, describe the shapes instead — so a
      // shape-only lasso still makes a sticky. Still selected here (we clear the
      // lasso further down), so getLassoGeometries() sees them.
      try {
        const geoR = await PluginCommAPI.getLassoGeometries();
        const geos = geoR && geoR.success ? geoR.result : null;
        text = describeGeometries(geos);
      } catch (e) {
        blog(`[lasso] getLassoGeometries failed: ${e && e.message}`);
      }
    }
    if (!text) {
      ToastAndroid.show('Nothing recognized', ToastAndroid.SHORT);
      return;
    }
    // Optionally mark on the note what we just captured.
    if (lassoRect) {
      await drawFrame(lassoRect, frameStyle);
    }
    // Auto-dismiss the lasso selection so the user doesn't have to tap away
    // (2 = completely remove the lasso box; does NOT delete the handwriting).
    try {
      await PluginCommAPI.setLassoBoxState(2);
    } catch (e) {
      blog(`[lasso] setLassoBoxState failed: ${e && e.message}`);
    }
    const atLimit = getOpen().length >= getMaxCards();
    const note = create(DEFAULT_ICON);
    // Backlink: remember where this OCR came from so the Manager can jump back.
    update(note.id, {
      body: text,
      sourceFile: path,
      sourcePage: page,
      sourceKind: isNote ? 'note' : 'doc',
      ...(autoLabels.length > 0 ? {labels: autoLabels} : {}),
    });
    if (!atLimit) {
      placeForOpen(note.id);
      setOpen(note.id, true);
      await syncOpenCards();
    }
    const labelNote = autoLabels.length > 0 ? ` · ${autoLabels.join(', ')}` : '';
    ToastAndroid.show(
      (atLimit
        ? 'Saved to a new sticky (screen full — see Manager)'
        : 'Added to a new sticky note') + labelNote,
      ToastAndroid.SHORT,
    );
  } catch (e) {
    blog(`[lasso] err: ${e && e.message}`);
    ToastAndroid.show(`OCR error: ${e && e.message}`, ToastAndroid.SHORT);
  }
}

// Tapping a card's icon opens the Manager (full list).
DeviceEventEmitter.addListener('onOpenManager', async () => {
  try {
    await PluginManager.showPluginView(); // cards stay on top of the Manager
  } catch (e) {
    blog(`[openmgr] err: ${e && e.message}`);
  }
});

// Plugin lifecycle (Chauvet). `addPluginLifeListener` was REMOVED in
// sn-plugin-lib 0.1.65 → `registerPluginLifeListener({onMsg})`, msg.state:
//   0 initialized · 1 mounted · 2 start · 3 stop · 4 unmounted · 5 destroyed
// start(2)/stop(3) bracket each plugin-VIEW session (Manager open/close) and
// fire repeatedly — we must NOT touch the overlay there or the persistent
// floating cards would be wiped every time the Manager closes.
// unmounted(4)/destroyed(5) are the plugin TEARDOWN: the JS is going away but
// the pluginhost PROCESS lives on, so any TYPE_APPLICATION_OVERLAY windows we
// left behind become ORPHANS that no future classloader can control. Flush the
// store and clearAll() so a reload/reinstall starts clean (boot() re-paints the
// cards from the store).
const LIFE = ['initialized', 'mounted', 'start', 'stop', 'unmounted', 'destroyed'];
PluginManager.registerPluginLifeListener({
  onMsg: async msg => {
    const state = msg && typeof msg.state === 'number' ? msg.state : -1;
    blog(`[life] state=${state} (${LIFE[state] || '?'})`);
    if (state === 4 || state === 5) {
      try {
        await flush(); // persist any debounced geometry/body edit before teardown
      } catch {}
      try {
        await StickyNative?.clearAll(); // remove our overlay windows → no orphans
      } catch (e) {
        blog(`[life] clearAll on teardown failed: ${e && e.message}`);
      }
    }
  },
});

// ---- Toolbar entry point --------------------------------------------------

const TOOLBAR_BTN = 100;
const LASSO_BTN = 200;
const DOC_BTN = 300;

PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: TOOLBAR_BTN,
  name: 'SuperStickyNote',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});

/**
 * DOC selection → "Add to StickyNote": the text is already text in a PDF, so
 * there is nothing to recognise — read the selection, keep the backlink.
 * getLastSelectedText FAILS by design when nothing is selected.
 */
async function handleDocSelection() {
  try {
    let text = '';
    try {
      const r = await PluginDocAPI.getLastSelectedText();
      text = r && r.success && typeof r.result === 'string' ? r.result : '';
    } catch (e) {
      blog(`[doc] getLastSelectedText threw: ${e && e.message}`);
    }
    if (!text.trim()) {
      ToastAndroid.show('Select some text first', ToastAndroid.SHORT);
      return;
    }
    let path = null;
    let page = null;
    try {
      const p = await PluginCommAPI.getCurrentFilePath();
      path = p && p.success ? p.result : null;
    } catch (e) {
      blog(`[doc] getCurrentFilePath failed: ${e && e.message}`);
    }
    try {
      const g = await PluginCommAPI.getCurrentPageNum();
      page = g && g.success && typeof g.result === 'number' ? g.result : null;
    } catch (e) {
      blog(`[doc] getCurrentPageNum failed: ${e && e.message}`);
    }
    // At the on-screen limit the sticky is still created — it just waits in the
    // Manager instead of stealing a card, exactly as the lasso capture does.
    const atLimit = getOpen().length >= getMaxCards();
    const note = create(DEFAULT_ICON);
    const patch = {body: text, sourceKind: 'doc'};
    if (path) patch.sourceFile = path;
    if (page != null) patch.sourcePage = page;
    update(note.id, patch);
    if (!atLimit) {
      placeForOpen(note.id);
      setOpen(note.id, true);
      await syncOpenCards();
    }
    blog(`[doc] captured ${text.length} chars from ${path || '?'} p${page}`);
    ToastAndroid.show(
      atLimit
        ? 'Saved to a new sticky (screen full — see Manager)'
        : 'Added to a new sticky note',
      ToastAndroid.SHORT,
    );
  } catch (e) {
    blog(`[doc] err: ${e && e.message}`);
    ToastAndroid.show(`Capture failed: ${e && e.message}`, ToastAndroid.SHORT);
  }
}

// Lasso toolbar button (NOTE only): OCR the selection into a new sticky.
// showType:0 → act headless (no plugin view), we handle it in onButtonPress.
// Registered for DOC as well: a PDF/EPUB can carry handwritten annotations, and
// the firmware surfaces the same lasso toolbar over them. Everything that WRITES
// on the page is gated to .note inside the handler (a document has no geometry
// layer of ours to draw into).
PluginManager.registerButton(2, ['NOTE', 'DOC'], {
  id: LASSO_BTN,
  name: 'Add to StickyNote',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  editDataTypes: [0, 1, 2, 3, 4, 5], // 0=stroke 1=title 2=picture 3=text 4=link 5=geometry
  showType: 0,
});

// DOC selection toolbar (PDF/EPUB): turn the selected text into a sticky.
// Button type 3 is the selection toolbar, DOC only; editDataTypes is documented
// as lasso-only, so it is not declared here. showType:0 → act headless.
PluginManager.registerButton(3, ['DOC'], {
  id: DOC_BTN,
  name: 'Add to StickyNote',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 0,
});

PluginManager.registerButtonListener({
  onButtonPress(e) {
    if (e && e.id === LASSO_BTN) {
      handleLassoToSticky();
      return;
    }
    if (e && e.id === DOC_BTN) {
      handleDocSelection();
      return;
    }
    // Toolbar (showType:1) opens the Manager; cards stay on top for live preview.
    blog('[btn] toolbar pressed');
  },
});
