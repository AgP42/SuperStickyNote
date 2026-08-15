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

import {PluginManager} from 'sn-plugin-lib';
import {StickyNative, MAX_CARDS, blog} from './src/native';
import {DEFAULT_ICON} from './src/icons';
import {
  initStore,
  create,
  update,
  setOpen,
  setGeometry,
  setSize,
  getOpen,
  toCardPayload,
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
    await StickyNative?.showBubble();
  } catch (e) {
    blog(`[bub] show failed: ${e && e.message}`);
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

/** Manager opening: pull the cards/bubble down so they don't sit over the panel. */
global.__ssnHideOverlay = hideOverlay;
/** Manager closed: bring the open post-its + bubble back. */
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

// Tapping a card's icon opens the Manager (full list).
DeviceEventEmitter.addListener('onOpenManager', async () => {
  await hideOverlay(); // clear the cards/bubble before the panel appears
  try {
    await PluginManager.showPluginView();
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

PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: 100,
  name: 'SuperStickyNote',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});

PluginManager.registerButtonListener({
  // showType:1 opens the plugin view (the Manager); hide the overlay so the
  // cards/bubble don't float over it (restored when the Manager closes).
  onButtonPress() {
    blog('[btn] toolbar pressed');
    hideOverlay();
  },
});
