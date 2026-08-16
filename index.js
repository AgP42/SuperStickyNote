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

import {PluginManager, PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';
import {StickyNative, MAX_CARDS, blog} from './src/native';
import {DEFAULT_ICON} from './src/icons';
import {
  initStore,
  create,
  update,
  setOpen,
  setGeometry,
  setSize,
  placeForOpen,
  getOpen,
  toCardPayload,
  getBubbleHidden,
} from './src/store';

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

/** Reflect the store's open notes onto the native cards. */
async function syncOpenCards() {
  if (!hasPermission) return;
  try {
    await StickyNative?.syncCards(getOpen().map(toCardPayload));
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

/** Hide everything while the plugin view (Manager/editor) is on screen. */
async function hideOverlay() {
  try {
    await StickyNative?.hideAllCards();
  } catch {}
  try {
    await StickyNative?.hideBubble();
  } catch {}
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
  if (getOpen().length >= MAX_CARDS) {
    ToastAndroid.show(
      `Max ${MAX_CARDS} sticky notes on screen — close one first`,
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
  if (payload && payload.id != null) update(payload.id, {body: payload.body});
});

DeviceEventEmitter.addListener('onCardClose', payload => {
  const id = payload && payload.id;
  if (id) setOpen(id, false); // native already removed the card view
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

// Lasso → "Add to sticky": OCR the selection and drop it into a new post-it.
async function handleLassoToSticky() {
  try {
    ToastAndroid.show('Recognizing…', ToastAndroid.SHORT);
    const pathR = await PluginCommAPI.getCurrentFilePath();
    const path = pathR && pathR.success ? pathR.result : null;
    if (!path) {
      ToastAndroid.show('No open note', ToastAndroid.SHORT);
      return;
    }
    const pageR = await PluginCommAPI.getCurrentPageNum();
    const page = pageR && pageR.success ? pageR.result : 1;
    const sizeR = await PluginFileAPI.getPageSize(path, page);
    const size = sizeR && sizeR.success ? sizeR.result : null;
    if (!size) {
      ToastAndroid.show('Could not read the page size', ToastAndroid.SHORT);
      return;
    }
    const elR = await PluginCommAPI.getLassoElements();
    const els = elR && elR.success ? elR.result : [];
    if (!els || els.length === 0) {
      ToastAndroid.show('Nothing selected', ToastAndroid.SHORT);
      return;
    }
    // Full page size (NOT the lasso rect) or the recognizer throws.
    const recR = await PluginCommAPI.recognizeElements(els, size);
    for (const e of els) {
      try {
        e && e.recycle && e.recycle();
      } catch {}
    }
    const text = recR && recR.success ? (recR.result || '').trim() : '';
    if (!text) {
      ToastAndroid.show('Nothing recognized', ToastAndroid.SHORT);
      return;
    }
    const atLimit = getOpen().length >= MAX_CARDS;
    const note = create(DEFAULT_ICON);
    update(note.id, {body: text});
    if (!atLimit) {
      placeForOpen(note.id);
      setOpen(note.id, true);
      await syncOpenCards();
    }
    ToastAndroid.show(
      atLimit ? 'Saved to a new sticky (screen full — see Manager)' : 'Added to a new sticky note',
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

// Observe only — never act (the host dispatches other plugins' life events too).
PluginManager.addPluginLifeListener({
  onStart: () => blog('[life] start'),
  onStop: () => blog('[life] stop'),
});

// ---- Toolbar entry point --------------------------------------------------

const TOOLBAR_BTN = 100;
const LASSO_BTN = 200;

PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: TOOLBAR_BTN,
  name: 'SuperStickyNote',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});

// Lasso toolbar button (NOTE only): OCR the selection into a new sticky.
// showType:0 → act headless (no plugin view), we handle it in onButtonPress.
PluginManager.registerButton(2, ['NOTE'], {
  id: LASSO_BTN,
  name: 'Add to sticky',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  editDataTypes: [0, 1, 2, 3, 4],
  showType: 0,
});

PluginManager.registerButtonListener({
  onButtonPress(e) {
    if (e && e.id === LASSO_BTN) {
      handleLassoToSticky();
      return;
    }
    // Toolbar (showType:1) opens the Manager; cards stay on top for live preview.
    blog('[btn] toolbar pressed');
  },
});
