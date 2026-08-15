/**
 * SuperStickyNote — Manager page (list / new / actions).
 * Editing happens INLINE in the floating post-it itself (native EditText +
 * keyboard toggle), not here — there is no full-page editor.
 */
import React, {useEffect, useState, useCallback} from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  Image,
  StyleSheet,
  ToastAndroid,
} from 'react-native';
import {PluginManager, PluginCommAPI, PluginNoteAPI} from 'sn-plugin-lib';

import {StickyNative, EXPORT_DIR, MAX_CARDS} from './src/native';
import {
  initStore,
  subscribe,
  getAll,
  create,
  update,
  remove,
  setOpen,
  placeForOpen,
  getFontKey,
  setFontKey,
  FontKey,
  exportAllTxt,
  exportOneTxt,
  exportJson,
  importJson,
  title as noteTitle,
  Note,
} from './src/store';
import {ICONS} from './src/icons';

const FONT_KEYS: FontKey[] = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const KOFI_QR = require('./assets/kofi-qr.png');

declare const global: {
  __ssnEnableOverlay?: () => Promise<boolean>;
  __ssnRestoreOverlay?: () => Promise<void>;
};

function toast(msg: string) {
  try {
    ToastAndroid.show(msg, ToastAndroid.SHORT);
  } catch {}
}

function closeView() {
  PluginManager.closePluginView().catch(() => {});
  // Bring the floating post-its + bubble back now the Manager is gone.
  global.__ssnRestoreOverlay?.();
}

const App = () => {
  const [ready, setReady] = useState(false);
  const [, force] = useState(0);
  const rerender = useCallback(() => force(n => n + 1), []);

  useEffect(() => {
    initStore().then(() => setReady(true));
    const offStore = subscribe(rerender);
    // When the Manager view goes away — including via the system back/gesture,
    // not just our ✕ — bring the floating post-its + bubble back.
    return () => {
      offStore();
      global.__ssnRestoreOverlay?.();
    };
  }, [rerender]);

  // Full-screen page (like Dashboard). No centered panel — a maxHeight-only
  // panel collapsed the flex:1 ScrollView to a thin bar.
  return (
    <View style={styles.page}>{ready ? <Manager /> : null}</View>
  );
};

// ---- Permission -----------------------------------------------------------

const PermissionBanner = () => {
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    StickyNative?.checkPermission()
      .then(ok => setGranted(ok === true))
      .catch(() => setGranted(false));
  }, []);

  if (granted !== false) return null;

  const grant = async () => {
    await StickyNative?.requestPermission().catch(() => {});
    setTimeout(async () => {
      const ok = await StickyNative?.checkPermission().catch(() => false);
      setGranted(ok === true);
      if (ok) global.__ssnEnableOverlay?.();
    }, 500);
  };

  return (
    <View style={styles.banner}>
      <Text style={styles.bannerTxt}>
        Floating post-its need the overlay permission.
      </Text>
      <TouchableOpacity style={styles.bannerBtn} onPress={grant}>
        <Text style={styles.bannerBtnTxt}>Grant</Text>
      </TouchableOpacity>
    </View>
  );
};

// ---- Manager --------------------------------------------------------------

const FontSizeRow = () => {
  const cur = getFontKey();
  return (
    <View style={styles.sizeRow}>
      <Text style={styles.sizeLabel}>Text size</Text>
      {FONT_KEYS.map(k => (
        <TouchableOpacity
          key={k}
          style={[styles.sizeBtn, cur === k && styles.sizeBtnOn]}
          onPress={() => setFontKey(k)}>
          <Text style={cur === k ? styles.sizeTxtOn : styles.sizeTxt}>{k}</Text>
        </TouchableOpacity>
      ))}
      <Text style={styles.sizeHint}>applies to post-its</Text>
    </View>
  );
};

const Manager = () => {
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);
  const notes = getAll();
  const openCount = notes.filter(n => n.open).length;

  const q = query.trim().toLowerCase();
  const shown = q ? notes.filter(n => n.body.toLowerCase().includes(q)) : notes;

  const newNote = (icon: string) => {
    if (notes.filter(n => n.open).length >= MAX_CARDS) {
      toast(`Max ${MAX_CARDS} sticky notes on screen — close one first`);
      return;
    }
    const n = create(icon);
    placeForOpen(n.id);
    setOpen(n.id, true);
    setPicking(false);
    // Leave the panel → the new post-it floats on the canvas; tap it to type.
    closeView();
  };

  return (
    <View style={styles.fill}>
      <View style={styles.header}>
        <View>
          <Text style={styles.h1}>SuperStickyNote</Text>
          <Text style={styles.sub}>
            {notes.length} notes · {openCount} on screen
          </Text>
        </View>
        <View style={styles.row}>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => setPicking(p => !p)}>
            <Text style={styles.primaryBtnTxt}>＋ New note</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.ghostBtn} onPress={closeView}>
            <Text style={styles.ghostBtnTxt}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      <PermissionBanner />

      <FontSizeRow />

      {picking && (
        <View style={styles.pickerRow}>
          <Text style={styles.pickerLabel}>Pick an icon:</Text>
          {ICONS.map(ic => (
            <TouchableOpacity
              key={ic}
              style={styles.pickIcon}
              onPress={() => newNote(ic)}>
              <Text style={styles.pickIconTxt}>{ic}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search notes…"
          placeholderTextColor="#666"
          value={query}
          onChangeText={setQuery}
        />
        {query.length > 0 && (
          <TouchableOpacity style={styles.searchClear} onPress={() => setQuery('')}>
            <Text style={styles.searchClearTxt}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView style={styles.fill} keyboardShouldPersistTaps="handled">
        {shown.length === 0 && (
          <Text style={styles.empty}>
            {q ? 'No matching notes.' : 'No notes yet. Tap ＋ New note.'}
          </Text>
        )}
        {shown.map(n => (
          <NoteRow key={n.id} note={n} />
        ))}
        <View style={{height: 24}} />
      </ScrollView>

      <BackupRow />
      <KofiFooter />
    </View>
  );
};

const BackupRow = () => {
  const exportTxt = async () => {
    try {
      const n = await exportAllTxt();
      toast(`Exported ${n} note${n === 1 ? '' : 's'} (.txt) to ${EXPORT_DIR}`);
    } catch (e) {
      toast(`Export failed: ${(e as Error)?.message}`);
    }
  };
  const backupJson = async () => {
    try {
      const p = await exportJson();
      toast(`Backup saved: ${p}`);
    } catch (e) {
      toast(`Backup failed: ${(e as Error)?.message}`);
    }
  };
  const restoreJson = async () => {
    try {
      const n = await importJson();
      toast(`Imported ${n} note${n === 1 ? '' : 's'}`);
    } catch (e) {
      toast(`Import failed: ${(e as Error)?.message}`);
    }
  };
  return (
    <View style={styles.backupRow}>
      <Text style={styles.backupLabel}>Backup</Text>
      <Action label="Export all (.txt)" onPress={exportTxt} />
      <Action label="Export .json" onPress={backupJson} />
      <Action label="Import .json" onPress={restoreJson} />
    </View>
  );
};

const KofiFooter = () => (
  <View style={styles.kofiRow}>
    <View style={{flex: 1}}>
      <Text style={styles.kofiText}>
        Free &amp; made with love. Enjoying the sticky notes? Buy me a coffee →
      </Text>
      <Text selectable style={styles.kofiLink}>
        https://ko-fi.com/agp42
      </Text>
    </View>
    <Image source={KOFI_QR} style={styles.kofiQr} resizeMode="contain" />
  </View>
);

const NoteRow = ({note}: {note: Note}) => {
  const [pickIcon, setPickIcon] = useState(false);
  const t = noteTitle(note);
  const snippet = note.body.replace(/\s+/g, ' ').trim().slice(0, 80);

  const toggleOpen = () => {
    // Open: leave the panel so the post-it floats (restore syncs on close).
    // Close: just persist open:false; the card reconciles on next view-close.
    if (!note.open) {
      if (getAll().filter(n => n.open).length >= MAX_CARDS) {
        toast(`Max ${MAX_CARDS} sticky notes on screen — close one first`);
        return;
      }
      placeForOpen(note.id);
      setOpen(note.id, true);
      closeView();
    } else {
      setOpen(note.id, false);
    }
  };

  return (
    <View style={[styles.card, note.open && styles.cardOpen]}>
      <View style={styles.cardHead}>
        <TouchableOpacity onPress={() => setPickIcon(p => !p)}>
          <Text style={styles.cardIcon}>{note.icon}</Text>
        </TouchableOpacity>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {t}
        </Text>
        <View style={[styles.pill, note.open ? styles.pillOpen : styles.pillClosed]}>
          <Text style={note.open ? styles.pillOpenTxt : styles.pillClosedTxt}>
            {note.open ? 'ON SCREEN' : 'CLOSED'}
          </Text>
        </View>
      </View>
      {pickIcon && (
        <View style={styles.pickerRow}>
          {ICONS.map(ic => (
            <TouchableOpacity
              key={ic}
              style={styles.pickIcon}
              onPress={() => {
                update(note.id, {icon: ic});
                setPickIcon(false);
              }}>
              <Text style={styles.pickIconTxt}>{ic}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      {!!snippet && (
        <Text style={styles.cardSnippet} numberOfLines={2}>
          {snippet}
        </Text>
      )}
      <View style={styles.actions}>
        <Action label={note.open ? 'Close' : 'Open'} onPress={toggleOpen} />
        <Action label="Insert" onPress={() => insertIntoNote(note)} />
        <Action label="Export" onPress={() => exportNote(note)} />
        <Action label="Delete" danger onPress={() => remove(note.id)} />
      </View>
    </View>
  );
};

const Action = ({
  label,
  onPress,
  danger,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
}) => (
  <TouchableOpacity style={styles.action} onPress={onPress}>
    <Text style={[styles.actionTxt, danger && styles.actionDanger]}>{label}</Text>
  </TouchableOpacity>
);

async function insertIntoNote(note: Note) {
  try {
    const pathRes: any = await PluginCommAPI.getCurrentFilePath();
    const path: string | undefined = pathRes?.success ? pathRes.result : undefined;
    if (!path || !path.toLowerCase().endsWith('.note')) {
      toast('Insert works only in a note (.note), not a document.');
      return;
    }
    const pageRes: any = await PluginCommAPI.getCurrentPageNum();
    if (!pageRes?.success) {
      toast('Could not read the current page.');
      return;
    }
    const res: any = await PluginNoteAPI.insertText({
      textContentFull: note.body,
      textRect: {left: 80, top: 150, right: 760, bottom: 450},
      fontSize: 32,
      textAlign: 0,
      textFrameWidthType: 1,
      textFrameStyle: 0,
      textEditable: 0,
    });
    toast(res?.success ? 'Inserted into note.' : `Insert failed: ${res?.error?.message ?? ''}`);
    if (res?.success) closeView();
  } catch (e) {
    toast(`Insert error: ${(e as Error)?.message}`);
  }
}

async function exportNote(note: Note) {
  try {
    const path = await exportOneTxt(note);
    toast(`Exported to ${path}`);
  } catch (e) {
    toast(`Export error: ${(e as Error)?.message}`);
  }
}

// ---- Styles (e-ink: pure black on white, thick borders, no grey nuance) ---

const BLACK = '#000000';
const WHITE = '#FFFFFF';

const styles = StyleSheet.create({
  page: {flex: 1, backgroundColor: WHITE, padding: 16},
  fill: {flex: 1},
  row: {flexDirection: 'row', alignItems: 'center'},
  header: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, borderBottomWidth: 2, borderBottomColor: BLACK, paddingBottom: 10},
  h1: {fontSize: 24, fontWeight: '800', color: BLACK, maxWidth: 340},
  sub: {fontSize: 13, color: BLACK, marginTop: 2},
  primaryBtn: {backgroundColor: BLACK, paddingHorizontal: 16, paddingVertical: 10, marginRight: 8},
  primaryBtnTxt: {color: WHITE, fontWeight: '800', fontSize: 16},
  ghostBtn: {borderWidth: 2, borderColor: BLACK, width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  ghostBtnTxt: {fontSize: 20, color: BLACK, fontWeight: '800'},
  pickerRow: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginBottom: 12},
  pickerLabel: {color: BLACK, marginRight: 8, fontWeight: '700'},
  pickIcon: {borderWidth: 2, borderColor: BLACK, width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginRight: 8, marginBottom: 8},
  pickIconTxt: {fontSize: 24, color: BLACK},
  searchRow: {flexDirection: 'row', alignItems: 'center', borderWidth: 2, borderColor: BLACK, marginBottom: 12},
  searchInput: {flex: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: BLACK},
  searchClear: {paddingHorizontal: 14, paddingVertical: 10, borderLeftWidth: 2, borderLeftColor: BLACK},
  searchClearTxt: {fontSize: 18, color: BLACK, fontWeight: '800'},
  sizeRow: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 12},
  sizeLabel: {color: BLACK, fontWeight: '700', marginRight: 10},
  sizeBtn: {borderWidth: 2, borderColor: BLACK, minWidth: 40, paddingHorizontal: 10, paddingVertical: 6, alignItems: 'center', marginRight: 8, backgroundColor: WHITE},
  sizeBtnOn: {backgroundColor: BLACK},
  sizeTxt: {color: BLACK, fontWeight: '800'},
  sizeTxtOn: {color: WHITE, fontWeight: '800'},
  sizeHint: {color: BLACK, fontSize: 11, fontStyle: 'italic', marginLeft: 2},
  empty: {color: BLACK, textAlign: 'center', marginVertical: 28, fontSize: 16},
  banner: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: BLACK, padding: 12, marginBottom: 12},
  bannerTxt: {flex: 1, color: WHITE, fontSize: 15, marginRight: 10, fontWeight: '600'},
  bannerBtn: {backgroundColor: WHITE, paddingHorizontal: 16, paddingVertical: 10},
  bannerBtnTxt: {color: BLACK, fontWeight: '800'},
  card: {borderWidth: 2, borderColor: BLACK, padding: 12, marginBottom: 12},
  cardOpen: {borderWidth: 4},
  cardHead: {flexDirection: 'row', alignItems: 'center'},
  cardIcon: {fontSize: 18, marginRight: 8, color: BLACK},
  cardTitle: {flex: 1, fontSize: 17, fontWeight: '800', color: BLACK},
  cardSnippet: {color: BLACK, marginTop: 8, fontSize: 14},
  pill: {paddingHorizontal: 10, paddingVertical: 3, borderWidth: 2, borderColor: BLACK},
  pillOpen: {backgroundColor: BLACK},
  pillClosed: {backgroundColor: WHITE},
  pillOpenTxt: {color: WHITE, fontSize: 11, fontWeight: '800'},
  pillClosedTxt: {color: BLACK, fontSize: 11, fontWeight: '800'},
  actions: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 12},
  action: {borderWidth: 2, borderColor: BLACK, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, marginBottom: 8},
  actionTxt: {fontSize: 15, color: BLACK, fontWeight: '700'},
  actionDanger: {fontStyle: 'italic'},
  backupRow: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 4},
  backupLabel: {color: BLACK, fontWeight: '700', marginRight: 8, marginBottom: 8},
  kofiRow: {flexDirection: 'row', alignItems: 'center', borderTopWidth: 2, borderTopColor: BLACK, paddingTop: 8, marginTop: 4},
  kofiText: {fontSize: 12, color: BLACK, lineHeight: 17},
  kofiLink: {fontSize: 12, color: BLACK, fontWeight: '800', marginTop: 2},
  kofiQr: {width: 74, height: 74, borderWidth: 1, borderColor: BLACK, marginLeft: 10},
});

export default App;
