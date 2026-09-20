/**
 * SuperStickyNote — Manager page, in the native Supernote language.
 *
 * Two panes: a left rail of filters with counts, and a paged list of notes.
 * Editing happens INLINE in the floating post-it itself (native EditText +
 * keyboard toggle); the Manager's note screen is the second way in, for when
 * the card isn't on screen.
 *
 * House rules, all of them borrowed from the device's own apps (see src/dimens):
 *  - hairline frames; 2 dp ONLY to mark a selection, never a black fill
 *  - dotted rules between rows, solid only under the header
 *  - actions live in one bar for the selected note, not on every row
 *  - pages, not a long scroll: e-ink turns pages, it doesn't scroll well
 */
import React, {useEffect, useState, useCallback, useRef} from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  Image,
  PixelRatio,
  StyleSheet,
  ToastAndroid,
} from 'react-native';
import {PluginManager, PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';

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
  allLabels,
  closeAll,
  getFontKey,
  setFontKey,
  FontKey,
  getFont,
  setFont,
  rnFamily,
  getBubbleHidden,
  setBubbleHidden,
  getFrameStyle,
  setFrameStyle,
  getMaxCards,
  setMaxCards,
  SAFE_MAX_CARDS,
  FrameStyle,
  FontInfo,
  exportAllTxt,
  exportOneTxt,
  exportJson,
  importJson,
  title as noteTitle,
  Note,
} from './src/store';
import {ICONS} from './src/icons';
import {dp, T, CARD_H, ACTION_H, BLACK, WHITE, DOTTED} from './src/dimens';
import {insertIntoNote} from './src/tonote';

const FONT_KEYS: FontKey[] = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
/** Breathing room above the first card — counted out of the page arithmetic. */
const LIST_PAD = dp(14);
const KOFI_QR = require('./assets/kofi-qr.png');

declare const global: {
  __ssnEnableOverlay?: () => Promise<boolean>;
  __ssnRestoreOverlay?: () => Promise<void>;
  __ssnSyncCards?: () => Promise<void>;
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

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "September 19, 2026   18:42" — the date line the native lists use. */
function fmtWhen(ts: number): string {
  const d = new Date(ts || Date.now());
  const p = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}   ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "Carnet pro.note - Page 12" — the note/document a sticky was captured from. */
function fmtSource(n: Note): string {
  if (!n.sourceFile) return '';
  const name = n.sourceFile.split('/').pop() || n.sourceFile;
  // sourcePage is the firmware's 0-based index; the reader shows 1-based.
  return n.sourcePage == null ? name : `${name} - Page ${n.sourcePage + 1}`;
}

/** The first non-empty line, minus the title line, on one line. */
function snippetOf(n: Note): string {
  const lines = n.body.split('\n');
  const first = lines.findIndex(l => l.trim().length > 0);
  const rest = lines.slice(first + 1).join(' ').replace(/\s+/g, ' ').trim();
  return rest;
}

// ---- Filters ---------------------------------------------------------------

const F_ALL = ':all';
const F_OPEN = ':open';
const F_UNTAGGED = ':untagged';

function filterPass(n: Note, filter: string): boolean {
  if (filter === F_ALL) return true;
  if (filter === F_OPEN) return !!n.open;
  if (filter === F_UNTAGGED) return (n.labels || []).length === 0;
  return (n.labels || []).includes(filter);
}

function filterName(filter: string): string {
  if (filter === F_ALL) return 'All';
  if (filter === F_OPEN) return 'On screen';
  if (filter === F_UNTAGGED) return 'Untagged';
  return filter;
}

// ---- Root ------------------------------------------------------------------

const App = () => {
  const [ready, setReady] = useState(false);
  const [, force] = useState(0);
  const rerender = useCallback(() => force(n => n + 1), []);

  useEffect(() => {
    initStore().then(() => setReady(true));
    const offStore = subscribe(opts => {
      rerender();
      // An edit typed IN a floating card needs no card sync — the native
      // EditText is the source of that text. Pushing it back mid-typing is
      // what used to rewind the caret to the start of the note.
      if (!opts?.fromCard && !opts?.quiet) global.__ssnSyncCards?.();
    });
    // When the Manager view goes away — including via the system back/gesture,
    // not just our ✕ — bring the floating post-its + bubble back.
    return () => {
      offStore();
      global.__ssnRestoreOverlay?.();
    };
  }, [rerender]);

  return <View style={styles.page}>{ready ? <Manager /> : null}</View>;
};

// ---- Manager ---------------------------------------------------------------

type Screen = 'list' | 'note' | 'settings';

const Manager = () => {
  const [screen, setScreen] = useState<Screen>('list');
  const [filter, setFilter] = useState(F_ALL);
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [listH, setListH] = useState(0);

  const notes = getAll();
  const openCount = notes.filter(n => n.open).length;

  const q = query.trim().toLowerCase();
  const shown = notes.filter(
    n => (q ? n.body.toLowerCase().includes(q) : true) && filterPass(n, filter),
  );

  // listH is the container INCLUDING its padding, and a page always reserves
  // room for one unfolded card's action row.
  const perPage = Math.max(
    1,
    Math.floor((listH - LIST_PAD - ACTION_H + T.gap) / (CARD_H + T.gap)),
  );
  const lastPage = Math.max(0, Math.ceil(shown.length / perPage) - 1);
  const safePage = Math.min(page, lastPage);
  const pageNotes = shown.slice(safePage * perPage, safePage * perPage + perPage);

  // A new filter or search starts at the first page.
  useEffect(() => {
    setPage(0);
  }, [filter, q]);

  const newNote = (icon: string) => {
    if (openCount >= getMaxCards()) {
      toast(`Max ${getMaxCards()} sticky notes on screen — close one first`);
      return;
    }
    const n = create(icon);
    placeForOpen(n.id);
    setOpen(n.id, true);
    setPicking(false);
    setSelectedId(n.id);
    // The new post-it floats on top of the Manager (which stays open); tap it to type.
  };

  const openNote = (id: string) => {
    setEditId(id);
    setScreen('note');
  };

  const editing = editId ? notes.find(n => n.id === editId) : undefined;

  if (screen === 'note' && editing) {
    return (
      <NoteScreen
        key={editing.id}
        note={editing}
        onBack={() => {
          setEditId(null);
          setScreen('list');
        }}
      />
    );
  }

  if (screen === 'settings') {
    return <SettingsScreen openCount={openCount} onBack={() => setScreen('list')} />;
  }

  return (
    <View style={styles.fill}>
      <Header title="SuperStickyNote" />
      <View style={styles.body}>
        <Rail
          notes={notes}
          filter={filter}
          onFilter={f => {
            setFilter(f);
            setSelectedId(null);
          }}
          onNew={() => setPicking(p => !p)}
          onSettings={() => setScreen('settings')}
        />
        <View style={styles.pane}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>{filterName(filter)}</Text>
            <View style={styles.grow} />
            <Text style={styles.sectionCount}>
              {shown.length} note{shown.length === 1 ? '' : 's'}
            </Text>
          </View>
          <View style={styles.ruleSolid} />

          <PermissionBanner />

          <View style={styles.searchRow}>
            <TextInput
              style={styles.searchInput}
              placeholder="Search notes…"
              placeholderTextColor={DOTTED}
              value={query}
              onChangeText={setQuery}
            />
            {query.length > 0 && (
              <TouchableOpacity
                style={styles.searchClear}
                onPress={() => setQuery('')}
                accessibilityLabel="Clear search">
                <Text style={styles.searchClearTxt}>✕</Text>
              </TouchableOpacity>
            )}
          </View>

          {picking && (
            <View style={styles.pickerRow}>
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

          <View
            style={styles.list}
            onLayout={e => setListH(e.nativeEvent.layout.height)}>
            {shown.length === 0 ? (
              <Text style={styles.empty}>
                {q ? 'No matching notes.' : 'No notes yet — tap New note.'}
              </Text>
            ) : (
              pageNotes.map(n => (
                <NoteCard
                  key={n.id}
                  note={n}
                  selected={n.id === selectedId}
                  onPress={() => setSelectedId(id => (id === n.id ? null : n.id))}
                  onOpen={() => openNote(n.id)}
                  onGone={() => setSelectedId(null)}
                />
              ))
            )}
          </View>

          <Pager
            page={safePage}
            last={lastPage}
            onPage={p => {
              setPage(p);
              setSelectedId(null);
            }}
          />
        </View>
      </View>
    </View>
  );
};

// ---- Chrome ----------------------------------------------------------------

const Header = ({
  title,
  right,
  onRight,
  backLabel,
  onBack,
}: {
  title: string;
  right?: string;
  onRight?: () => void;
  backLabel?: string;
  onBack?: () => void;
}) => (
  <View style={styles.header}>
    <TouchableOpacity
      style={styles.headerBtn}
      onPress={onBack || closeView}
      accessibilityLabel={backLabel || 'Close'}>
      <Text style={styles.headerBtnTxt}>{backLabel ? `‹  ${backLabel}` : '✕'}</Text>
    </TouchableOpacity>
    <Text style={styles.headerTitle} numberOfLines={1}>
      {title}
    </Text>
    {onRight ? (
      <TouchableOpacity
        style={[styles.headerBtn, styles.headerBtnRight]}
        onPress={onRight}>
        <Text style={styles.headerBtnTxt}>{right || ''}</Text>
      </TouchableOpacity>
    ) : (
      <View style={styles.headerBtn} />
    )}
  </View>
);

const RailRow = ({
  label,
  count,
  on,
  onPress,
}: {
  label: string;
  count?: number;
  on?: boolean;
  onPress: () => void;
}) => (
  <TouchableOpacity style={[styles.railRow, on && styles.railRowOn]} onPress={onPress}>
    <Text style={[styles.railTxt, on && styles.railTxtOn]} numberOfLines={1}>
      {label}
    </Text>
    {count != null && <Text style={styles.railCount}>{count}</Text>}
  </TouchableOpacity>
);

const Rail = ({
  notes,
  filter,
  onFilter,
  onNew,
  onSettings,
}: {
  notes: Note[];
  filter: string;
  onFilter: (f: string) => void;
  onNew: () => void;
  onSettings: () => void;
}) => {
  // One pass: a filter() per rail row re-walked the whole cache on every store
  // change — including every character streamed from a floating card.
  let openCount = 0;
  let untagged = 0;
  const byLabel = new Map<string, number>();
  for (const n of notes) {
    if (n.open) openCount++;
    const ls = n.labels || [];
    if (ls.length === 0) untagged++;
    for (const l of ls) byLabel.set(l, (byLabel.get(l) || 0) + 1);
  }
  const labels = Array.from(byLabel.keys()).sort((a, b) => a.localeCompare(b));
  return (
    <View style={styles.rail}>
      <ScrollView
        style={styles.railTop}
        contentContainerStyle={styles.railTopInner}
        showsVerticalScrollIndicator={false}>
        <RailRow
          label="All"
          count={notes.length}
          on={filter === F_ALL}
          onPress={() => onFilter(F_ALL)}
        />
        <View style={styles.ruleDotted} />
        <RailRow
          label="On screen"
          count={openCount}
          on={filter === F_OPEN}
          onPress={() => onFilter(F_OPEN)}
        />
        <View style={styles.ruleDotted} />
        <RailRow
          label="Untagged"
          count={untagged}
          on={filter === F_UNTAGGED}
          onPress={() => onFilter(F_UNTAGGED)}
        />
        {labels.map(l => (
          <View key={l}>
            <View style={styles.ruleDotted} />
            <RailRow
              label={l}
              count={byLabel.get(l) || 0}
              on={filter === l}
              onPress={() => onFilter(l)}
            />
          </View>
        ))}
      </ScrollView>
      <View style={styles.ruleDotted} />
      <RailRow label="＋  New StickyNote" onPress={onNew} />
      <View style={styles.ruleDotted} />
      <RailRow label="⚙  Settings" onPress={onSettings} />
    </View>
  );
};

// ---- List ------------------------------------------------------------------

const NoteCard = ({
  note,
  selected,
  onPress,
  onOpen,
  onGone,
}: {
  note: Note;
  selected: boolean;
  onPress: () => void;
  onOpen: () => void;
  onGone: () => void;
}) => {
  const labels = note.labels || [];
  const source = fmtSource(note);
  const toggleOpen = () => {
    if (!note.open && getAll().filter(n => n.open).length >= getMaxCards()) {
      toast(`Max ${getMaxCards()} sticky notes on screen — close one first`);
      return;
    }
    // A note captured at the on-screen limit was never placed. Without this it
    // gets a position derived from its index in the open list, recomputed on
    // every sync — so the card jumps whenever another one opens or closes.
    if (!note.open) placeForOpen(note.id);
    setOpen(note.id, !note.open);
  };
  return (
    <TouchableOpacity
      style={[styles.card, selected && styles.cardSel, selected && styles.cardTall]}
      onPress={onPress}
      onLongPress={onOpen}>
      <View style={styles.cardHead}>
        <View style={[styles.cardIcon, note.open && styles.cardIconOn]}>
          <Text style={[styles.cardIconTxt, note.open && styles.cardIconTxtOn]}>
            {note.icon}
          </Text>
        </View>
        <Text
          style={[styles.cardTitle, {fontFamily: rnFamily()}]}
          numberOfLines={1}>
          {noteTitle(note)}
        </Text>
      </View>
      <Text
        style={[styles.cardBody, {fontFamily: rnFamily()}]}
        numberOfLines={2}>
        {snippetOf(note)}
      </Text>
      <View style={styles.cardMeta}>
        <Text style={styles.metaTxt}>{fmtWhen(note.updatedAt)}</Text>
        {!!source && (
          <Text style={styles.metaTxt} numberOfLines={1}>
            {source}
          </Text>
        )}
        <View style={styles.grow} />
        {labels.slice(0, 2).map(l => (
          <View key={l} style={styles.metaChip}>
            <Text style={styles.chipTxt} numberOfLines={1}>
              {l}
            </Text>
          </View>
        ))}
      </View>
      {selected && (
        <View style={styles.cardActions}>
          <CardBtn label={note.open ? 'Hide' : 'Show on screen'} onPress={toggleOpen} />
          <CardBtn label="Edit" onPress={onOpen} />
          <CardBtn label="Insert in note" onPress={() => toNote(note)} />
          {!!note.sourceFile && (
            <CardBtn label="Go to source" onPress={() => goToSource(note)} />
          )}
          <View style={styles.grow} />
          <CardBtn
            label="Delete"
            danger
            onPress={() => {
              remove(note.id);
              onGone();
            }}
          />
        </View>
      )}
    </TouchableOpacity>
  );
};

/** A framed button, so a tap target on a card reads as one. */
const CardBtn = ({
  label,
  onPress,
  danger,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
}) => (
  <TouchableOpacity style={styles.cardBtn} onPress={onPress}>
    <Text style={[styles.cardBtnTxt, danger && styles.barTxtDanger]}>{label}</Text>
  </TouchableOpacity>
);

const BarBtn = ({
  label,
  onPress,
  strong,
  danger,
}: {
  label: string;
  onPress: () => void;
  strong?: boolean;
  danger?: boolean;
}) => (
  <TouchableOpacity style={styles.barBtn} onPress={onPress}>
    <Text
      style={[styles.barTxt, strong && styles.barTxtStrong, danger && styles.barTxtDanger]}>
      {label}
    </Text>
  </TouchableOpacity>
);

const Pager = ({
  page,
  last,
  onPage,
}: {
  page: number;
  last: number;
  onPage: (p: number) => void;
}) => (
  <View style={styles.pager}>
    <TouchableOpacity
      style={styles.pagerBtn}
      disabled={page <= 0}
      onPress={() => onPage(0)}>
      <Text style={[styles.pagerTxt, page <= 0 && styles.pagerOff]}>«</Text>
    </TouchableOpacity>
    <TouchableOpacity
      style={styles.pagerBtn}
      disabled={page <= 0}
      onPress={() => onPage(page - 1)}>
      <Text style={[styles.pagerTxt, page <= 0 && styles.pagerOff]}>‹</Text>
    </TouchableOpacity>
    <Text style={styles.pagerNum}>
      {page + 1} / {last + 1}
    </Text>
    <TouchableOpacity
      style={styles.pagerBtn}
      disabled={page >= last}
      onPress={() => onPage(page + 1)}>
      <Text style={[styles.pagerTxt, page >= last && styles.pagerOff]}>›</Text>
    </TouchableOpacity>
    <TouchableOpacity
      style={styles.pagerBtn}
      disabled={page >= last}
      onPress={() => onPage(last)}>
      <Text style={[styles.pagerTxt, page >= last && styles.pagerOff]}>»</Text>
    </TouchableOpacity>
  </View>
);

// ---- Note screen -----------------------------------------------------------

const NoteScreen = ({note, onBack}: {note: Note; onBack: () => void}) => {
  // The text box keeps its OWN copy while it is being typed in. Binding it
  // straight to the store made every keystroke a round trip, and a late one
  // dropped the caret back to the start of the note.
  const [draft, setDraft] = useState(note.body);
  // What WE last wrote. The same note can be edited in its floating card at the
  // same time (cards sit on top of the Manager on purpose): when the body moves
  // underneath us, take it, or the next keystroke here would write our stale
  // copy back over what was typed in the card.
  const mine = useRef(note.body);
  useEffect(() => {
    if (note.body !== mine.current) {
      mine.current = note.body;
      setDraft(note.body);
    }
  }, [note.body]);
  const [labelDraft, setLabelDraft] = useState('');
  // Leaving this screen is the one moment the cards catch up: every keystroke
  // here is written quietly (no per-character sync), so BOTH ways out must go
  // through here or the floating card keeps — and then re-emits — stale text.
  const done = useCallback(() => {
    global.__ssnSyncCards?.();
    onBack();
  }, [onBack]);
  const [pickIcon, setPickIcon] = useState(false);
  const labels = note.labels || [];
  const suggestions = allLabels().filter(l => !labels.includes(l)).slice(0, 8);
  const source = fmtSource(note);

  const addLabel = (raw: string) => {
    const l = raw.trim();
    setLabelDraft('');
    if (!l || labels.includes(l)) return;
    update(note.id, {labels: [...labels, l]});
  };
  const copy = async () => {
    await StickyNative?.clipboardSet(draft).catch(() => {});
    toast('Copied');
  };
  return (
    <View style={styles.fill}>
      <Header title="Note" backLabel="Back" onBack={done} />
      <View style={styles.notePane}>
        <View style={styles.noteHead}>
          <TouchableOpacity
            style={styles.noteIcon}
            onPress={() => setPickIcon(p => !p)}>
            <Text style={styles.noteIconTxt}>{note.icon}</Text>
          </TouchableOpacity>
          <Text style={[styles.noteTitle, {fontFamily: rnFamily()}]} numberOfLines={1}>
            {noteTitle(note)}
          </Text>
          <View style={styles.grow} />
          <Text style={styles.metaTxt}>{fmtWhen(note.updatedAt)}</Text>
        </View>
        <View style={styles.ruleSolid} />

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

        <Text style={styles.fieldLabel}>Text</Text>
        <TextInput
          style={[styles.editor, {fontFamily: rnFamily()}]}
          multiline
          textAlignVertical="top"
          placeholder="Type your note… (first line becomes the title)"
          placeholderTextColor={DOTTED}
          value={draft}
          onChangeText={txt => {
            mine.current = txt;
            setDraft(txt);
            // quiet: the cards catch up once, when this screen closes.
            update(note.id, {body: txt}, {quiet: true});
          }}
        />

        <Text style={styles.fieldLabel}>Labels</Text>
        <View style={styles.chipWrap}>
          {labels.map(l => (
            <TouchableOpacity
              key={l}
              style={styles.chipOn}
              onPress={() =>
                update(note.id, {labels: labels.filter(x => x !== l)})
              }>
              <Text style={styles.chipOnTxt}>{l}  ✕</Text>
            </TouchableOpacity>
          ))}
          {suggestions.map(l => (
            <TouchableOpacity key={l} style={styles.chip} onPress={() => addLabel(l)}>
              <Text style={styles.chipTxt}>＋ {l}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={styles.row}>
          <TextInput
            style={styles.labelInput}
            placeholder="Add label…"
            placeholderTextColor={DOTTED}
            value={labelDraft}
            onChangeText={setLabelDraft}
            onSubmitEditing={() => addLabel(labelDraft)}
            returnKeyType="done"
          />
          <TouchableOpacity style={styles.addBtn} onPress={() => addLabel(labelDraft)}>
            <Text style={styles.addBtnTxt}>Add</Text>
          </TouchableOpacity>
        </View>

        {!!source && (
          <TouchableOpacity style={styles.sourceRow} onPress={() => goToSource(note)}>
            <Text style={styles.sourceTxt}>↪  {source}</Text>
          </TouchableOpacity>
        )}

        <View style={styles.grow} />
        <View style={styles.actionBar}>
          <BarBtn label="Done" strong onPress={done} />
          <BarBtn label="Copy" onPress={copy} />
          <BarBtn label="Insert in note" onPress={() => toNote(note)} />
          <BarBtn label="Export" onPress={() => exportNote(note)} />
          <View style={styles.grow} />
          <BarBtn
            label="Delete"
            danger
            onPress={() => {
              remove(note.id);
              done();
            }}
          />
        </View>
      </View>
    </View>
  );
};

// ---- Settings screen -------------------------------------------------------

const Opt = ({
  label,
  on,
  onPress,
  family,
  sample,
}: {
  label: string;
  on?: boolean;
  onPress: () => void;
  family?: string;
  sample?: FontSample;
}) => (
  <TouchableOpacity style={[styles.opt, on && styles.optOn]} onPress={onPress}>
    {sample ? (
      <Image
        source={{uri: `file://${sample.path}`}}
        style={{width: sample.w, height: sample.h}}
        resizeMode="contain"
        accessibilityLabel={label}
      />
    ) : (
      <Text
        style={[
          styles.optTxt,
          on && styles.optTxtOn,
          family ? {fontFamily: family} : null,
        ]}>
        {label}
      </Text>
    )}
  </TouchableOpacity>
);

/**
 * The launcher bubble's own mark: a note outline with a plus at its corner,
 * redrawn here from Views so it matches makeBubbleIcon() in the native module
 * exactly — and so there is no glyph to be missing from the device font.
 */
const BubbleIcon = () => (
  <View style={styles.bubbleIcon}>
    <View style={styles.bubbleNote} />
    <View style={styles.bubblePlusH} />
    <View style={styles.bubblePlusV} />
  </View>
);

const SettingRow = ({
  label,
  hint,
  hintIcon,
  children,
}: {
  label: string;
  hint?: string;
  hintIcon?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <>
    <View style={styles.setRow}>
      <View style={styles.setLabelBox}>
        <Text style={styles.setLabel}>{label}</Text>
        {(!!hint || !!hintIcon) && (
          <View style={styles.setHintRow}>
            {hintIcon}
            {!!hint && <Text style={styles.setHint}>{hint}</Text>}
          </View>
        )}
      </View>
      <View style={styles.setCtls}>{children}</View>
    </View>
    <View style={styles.ruleDotted} />
  </>
);

const FRAME_OPTS: {key: FrameStyle; label: string}[] = [
  {key: 'off', label: 'Off'},
  {key: 'black', label: 'Black'},
  {key: 'grey1', label: 'Grey 1'},
  {key: 'grey2', label: 'Grey 2'},
];

const SYS_FONTS = [
  {key: 'sans', label: 'Sans'},
  {key: 'serif', label: 'Serif'},
  {key: 'mono', label: 'Mono'},
];

interface FontSample {
  path: string;
  w: number;
  h: number;
}

/**
 * Render each MyStyle/fonts face to a PNG so the picker can show it in its own
 * typeface. React Native resolves fontFamily against fonts bundled at BUILD
 * time, so a font living on the SD card can never be previewed as text — only
 * as a picture drawn natively.
 */
/** Rendered samples, kept for the life of the process: Settings can be opened
 *  and closed all day without re-rasterising the same faces. */
const sampleCache: Record<string, FontSample> = {};

/** Stable file name per font PATH — an index would shift when fonts are added,
 *  and Image caches by URI, so entries would show each other's face. */
function pathKey(p: string): string {
  let h = 0;
  for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function useFontSamples(fonts: FontInfo[]): Record<string, FontSample> {
  const [samples, setSamples] = useState<Record<string, FontSample>>(sampleCache);
  useEffect(() => {
    let alive = true;
    const todo = fonts.filter(f => !sampleCache[f.path]);
    if (todo.length === 0) return;
    (async () => {
      const dir = (await StickyNative?.getFilesDir().catch(() => '')) || '';
      if (!dir) return;
      const px = PixelRatio.getPixelSizeForLayoutSize(T.fsBody);
      for (const f of todo) {
        try {
          const r = await StickyNative?.renderFontSample(
            f.path,
            f.name,
            px,
            `${dir}/superstickynote/fontsamples/${pathKey(f.path)}.png`,
          );
          if (r) {
            sampleCache[f.path] = {
              path: r.path,
              w: PixelRatio.roundToNearestPixel(r.w / PixelRatio.get()),
              h: PixelRatio.roundToNearestPixel(r.h / PixelRatio.get()),
            };
          }
        } catch {
          // A face the renderer can't open just stays a plain name.
        }
        if (!alive) return;
      }
      if (alive) setSamples({...sampleCache});
    })();
    return () => {
      alive = false;
    };
  }, [fonts]);
  return samples;
}

const SettingsScreen = ({
  openCount,
  onBack,
}: {
  openCount: number;
  onBack: () => void;
}) => {
  const maxDraftRef = useRef('');
  /** Clamp and store whatever is in the box; the store holds the bounded truth. */
  const commitMax = () => {
    setMaxCards(parseInt(maxDraftRef.current, 10) || getMaxCards());
  };
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const [, force] = useState(0);
  const bump = () => force(n => n + 1);
  const samples = useFontSamples(fonts);
  const [maxDraft, setMaxDraft] = useState(String(getMaxCards()));
  maxDraftRef.current = maxDraft;
  useEffect(() => {
    StickyNative?.listFonts().then(setFonts).catch(() => setFonts([]));
  }, []);
  const fontKey = getFontKey();
  const font = getFont();
  const hidden = getBubbleHidden();
  const frame = getFrameStyle();

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
      toast(
        n === 0
          ? 'Nothing new to import (existing notes kept)'
          : `Added ${n} note${n === 1 ? '' : 's'} — existing notes kept`,
      );
    } catch (e) {
      toast(`Import failed: ${(e as Error)?.message}`);
    }
  };
  const hideAll = () => closeAll();

  return (
    <View style={styles.fill}>
      <Header
        title="Settings"
        backLabel="Back"
        onBack={() => {
          commitMax(); // the field may never fire onBlur when it is unmounted
          onBack();
        }}
      />
      <View style={styles.notePane}>
        <SettingRow label="Text size" hint="Sticky notes and titles">
          {FONT_KEYS.map(k => (
            <Opt
              key={k}
              label={k}
              on={fontKey === k}
              onPress={() => {
                setFontKey(k);
                bump();
              }}
            />
          ))}
        </SettingRow>

        <SettingRow label="Font" hint="Plus any font in MyStyle/fonts">
          {SYS_FONTS.map(s => (
            <Opt
              key={s.key}
              label={s.label}
              family={rnFamily(s.key)}
              on={font === s.key}
              onPress={() => {
                setFont(s.key);
                bump();
              }}
            />
          ))}
          {fonts.map(f => (
            <Opt
              key={f.path}
              label={f.name}
              sample={samples[f.path]}
              on={font === f.path}
              onPress={() => {
                setFont(f.path);
                bump();
              }}
            />
          ))}
        </SettingRow>

        <SettingRow
          label="Launcher bubble"
          hintIcon={<BubbleIcon />}
          hint="The floating launcher over the page">
          <Opt
            label="Shown"
            on={!hidden}
            onPress={() => {
              setBubbleHidden(false);
              bump();
            }}
          />
          <Opt
            label="Hidden"
            on={hidden}
            onPress={() => {
              setBubbleHidden(true);
              bump();
            }}
          />
        </SettingRow>

        <SettingRow label="Frame on capture" hint="Box drawn on the note around captured text">
          {FRAME_OPTS.map(o => (
            <Opt
              key={o.key}
              label={o.label}
              on={frame === o.key}
              onPress={() => {
                setFrameStyle(o.key);
                bump();
              }}
            />
          ))}
        </SettingRow>

        <SettingRow label="Backup" hint={EXPORT_DIR}>
          <Opt label="Export all (.txt)" onPress={exportTxt} />
          <Opt label="Export .json" onPress={backupJson} />
          <Opt label="Import .json" onPress={restoreJson} />
        </SettingRow>

        <SettingRow
          label="Sticky notes on screen"
          hint={`${openCount} open · 1 to ${MAX_CARDS} allowed`}>
          <TextInput
            style={styles.maxInput}
            keyboardType="number-pad"
            maxLength={2}
            value={maxDraft}
            // Committed on blur only: writing settings.json per digit meant a
            // file write (and a re-render) for every keypress.
            onChangeText={t => {
              const digits = t.replace(/[^0-9]/g, '');
              maxDraftRef.current = digits;
              setMaxDraft(digits);
            }}
            onBlur={() => {
              // Whatever was left in the box, the store holds the clamped truth.
              commitMax();
              setMaxDraft(String(getMaxCards()));
              bump();
            }}
          />
          <Opt label="Hide all" onPress={hideAll} />
          {getMaxCards() > SAFE_MAX_CARDS && (
            <Text style={styles.warnTxt}>
              Over {SAFE_MAX_CARDS} floating notes can slow the device down.
            </Text>
          )}
        </SettingRow>

        <View style={styles.grow} />
        <View style={styles.kofiRow}>
          <View style={styles.grow}>
            <Text style={styles.kofiText}>
              Free &amp; made with love. Enjoying the sticky notes? Buy me a coffee
            </Text>
            <Text selectable style={styles.kofiLink}>
              https://ko-fi.com/agp42
            </Text>
          </View>
          <Image source={KOFI_QR} style={styles.kofiQr} resizeMode="contain" />
        </View>
      </View>
    </View>
  );
};

// ---- Permission ------------------------------------------------------------

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
        Floating sticky notes need the overlay permission.
      </Text>
      <TouchableOpacity style={styles.opt} onPress={grant}>
        <Text style={styles.optTxt}>Grant</Text>
      </TouchableOpacity>
    </View>
  );
};

// ---- Actions ---------------------------------------------------------------

/**
 * Drop this sticky's text onto the note page underneath, as an editable text
 * box, and leave the Manager so the user lands on the result.
 */
async function toNote(note: Note) {
  const r = await insertIntoNote(note);
  if (!r.ok) {
    toast(r.why || 'Insert failed');
    return;
  }
  toast('Inserted in the note');
  closeView();
}

async function exportNote(note: Note) {
  try {
    const path = await exportOneTxt(note);
    toast(`Exported to ${path}`);
  } catch (e) {
    toast(`Export error: ${(e as Error)?.message}`);
  }
}

/** Backlink: jump/open the note back to where it was captured (lasso→OCR). */
async function goToSource(note: Note) {
  const src = note.sourceFile;
  if (!src) return;
  try {
    const curR: any = await PluginCommAPI.getCurrentFilePath();
    const cur = curR && curR.success ? curR.result : null;
    let r: any;
    if (cur && cur === src && note.sourcePage != null) {
      // Source file is already open — just jump to the page (page ≥ 0).
      r = await PluginCommAPI.jumpToPage(note.sourcePage);
    } else {
      // Different/closed file — open it, jumping to the page (-1 = last-viewed).
      r = await PluginFileAPI.openFile(src, note.sourcePage != null ? note.sourcePage : -1);
    }
    if (r && r.success) {
      closeView(); // leave the Manager so the user lands on the source
    } else {
      toast(`Go to source failed: ${(r && r.error && r.error.message) || 'unknown'}`);
    }
  } catch (e) {
    toast(`Go to source failed: ${(e as Error)?.message}`);
  }
}

// ---- Styles ----------------------------------------------------------------
// Hairline frames, dotted rules, no black fills: see src/dimens for the tokens
// and how they were measured off the device's own apps.

const styles = StyleSheet.create({
  page: {flex: 1, backgroundColor: WHITE},
  fill: {flex: 1},
  grow: {flex: 1},
  row: {flexDirection: 'row', alignItems: 'center'},

  // Header
  header: {
    height: T.header,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: T.hair,
    borderBottomColor: BLACK,
    paddingHorizontal: dp(18),
  },
  headerBtn: {minWidth: dp(120), height: T.tap, justifyContent: 'center'},
  headerBtnRight: {alignItems: 'flex-end'},
  headerBtnTxt: {fontSize: T.fsBody, color: BLACK},
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: T.fsTitle,
    fontWeight: '700',
    color: BLACK,
  },

  // Frame
  body: {flex: 1, flexDirection: 'row'},
  pane: {flex: 1, paddingHorizontal: T.pad},
  notePane: {flex: 1, paddingHorizontal: T.pad},

  // Rail
  rail: {
    width: T.rail,
    borderRightWidth: T.hair,
    borderRightColor: BLACK,
    paddingTop: dp(10),
  },
  railTop: {flex: 1},
  railTopInner: {paddingBottom: dp(8)},
  railRow: {
    height: T.railRow,
    marginHorizontal: dp(8),
    paddingHorizontal: dp(12),
    borderWidth: T.sel,
    borderColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
  },
  railRowOn: {borderColor: BLACK},
  railTxt: {flex: 1, fontSize: T.fsRail, color: BLACK},
  railTxtOn: {fontWeight: '700'},
  railCount: {fontSize: T.fsRail, color: BLACK, marginLeft: dp(8)},

  // Rules
  ruleSolid: {height: T.hair, backgroundColor: BLACK},
  ruleDotted: {
    borderTopWidth: T.hair,
    borderTopColor: DOTTED,
    borderStyle: 'dotted',
    marginHorizontal: dp(20),
  },

  // Section head
  sectionHead: {height: dp(62), flexDirection: 'row', alignItems: 'center'},
  sectionTitle: {fontSize: T.fsSection, fontWeight: '700', color: BLACK},
  sectionCount: {fontSize: T.fsMeta, color: BLACK},

  // Search + icon picker
  searchRow: {
    marginTop: dp(12),
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radCtl,
  },
  searchInput: {
    flex: 1,
    paddingHorizontal: dp(14),
    paddingVertical: dp(10),
    fontSize: T.fsBody,
    color: BLACK,
  },
  searchClear: {
    width: T.tap,
    height: T.tap,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchClearTxt: {fontSize: T.fsBody, color: BLACK},
  pickerRow: {flexDirection: 'row', flexWrap: 'wrap', marginTop: dp(12)},
  pickIcon: {
    width: T.tap,
    height: T.tap,
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radCtl,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: dp(8),
    marginBottom: dp(8),
  },
  pickIconTxt: {fontSize: T.fsNote, color: BLACK},

  // List
  list: {flex: 1, paddingTop: LIST_PAD},
  empty: {fontSize: T.fsBody, color: BLACK, textAlign: 'center', marginTop: dp(40)},
  card: {
    height: CARD_H,
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radCard,
    paddingVertical: T.cardPadV,
    paddingHorizontal: T.cardPadH,
    marginBottom: T.gap,
  },
  cardSel: {borderWidth: T.sel},
  cardTall: {height: CARD_H + ACTION_H},
  cardActions: {
    height: T.tap,
    marginTop: dp(12),
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardBtn: {
    height: T.tap,
    justifyContent: 'center',
    paddingHorizontal: dp(14),
    marginRight: dp(8),
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radCtl,
  },
  cardBtnTxt: {fontSize: T.fsMeta, color: BLACK},
  cardHead: {height: T.cardTitleH, flexDirection: 'row', alignItems: 'center'},
  cardIcon: {
    width: dp(30),
    height: dp(30),
    borderRadius: dp(5),
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: dp(9),
  },
  cardIconOn: {backgroundColor: BLACK},
  cardIconTxt: {fontSize: T.fsNote, color: BLACK},
  cardIconTxtOn: {color: WHITE},
  cardTitle: {flex: 1, fontSize: T.fsNote, fontWeight: '700', color: BLACK},
  cardBody: {
    height: T.lhBody * 2,
    marginTop: dp(6),
    fontSize: T.fsBody,
    lineHeight: T.lhBody,
    color: BLACK,
  },
  cardMeta: {
    height: T.cardMetaH,
    marginTop: dp(8),
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaTxt: {fontSize: T.fsMeta, color: BLACK, marginRight: dp(14), flexShrink: 1},
  metaChip: {
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radPill,
    paddingHorizontal: dp(12),
    paddingVertical: dp(4),
    marginLeft: dp(6),
    flexShrink: 0,
  },

  // Chips
  chip: {
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radPill,
    paddingHorizontal: dp(12),
    paddingVertical: dp(5),
    marginRight: dp(6),
    marginBottom: dp(6),
  },
  chipTxt: {fontSize: T.fsChip, lineHeight: dp(20), color: BLACK},
  chipOn: {
    borderWidth: T.sel,
    borderColor: BLACK,
    borderRadius: T.radPill,
    paddingHorizontal: dp(12),
    paddingVertical: dp(5) - (T.sel - T.hair),
    marginRight: dp(6),
    marginBottom: dp(6),
  },
  chipOnTxt: {fontSize: T.fsChip, lineHeight: dp(20), fontWeight: '600', color: BLACK},
  chipWrap: {flexDirection: 'row', flexWrap: 'wrap', marginBottom: dp(4)},

  // Action bar
  actionBar: {
    height: T.actionBar,
    borderTopWidth: T.hair,
    borderTopColor: BLACK,
    flexDirection: 'row',
    alignItems: 'center',
  },
  barBtn: {height: T.tap, justifyContent: 'center', paddingRight: dp(26)},
  barTxt: {fontSize: T.fsBody, color: BLACK},
  barTxtStrong: {fontWeight: '700'},
  barTxtDanger: {fontStyle: 'italic'},

  // Pager
  pager: {
    height: T.pager,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pagerBtn: {
    width: T.tap,
    height: T.tap,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: dp(10),
  },
  pagerTxt: {fontSize: T.fsSection, color: BLACK},
  pagerOff: {color: DOTTED},
  pagerNum: {
    fontSize: T.fsBody,
    fontWeight: '700',
    color: BLACK,
    borderBottomWidth: T.sel,
    borderBottomColor: BLACK,
    marginHorizontal: dp(6),
  },

  // Note screen
  noteHead: {height: dp(62), flexDirection: 'row', alignItems: 'center'},
  noteIcon: {
    width: dp(40),
    height: dp(40),
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radCtl,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: dp(12),
  },
  noteIconTxt: {fontSize: T.fsNote, color: BLACK},
  noteTitle: {fontSize: T.fsSection, fontWeight: '700', color: BLACK},
  fieldLabel: {fontSize: T.fsMeta, color: BLACK, marginTop: dp(16), marginBottom: dp(7)},
  editor: {
    height: dp(330),
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radCard,
    paddingHorizontal: dp(16),
    paddingVertical: dp(12),
    fontSize: T.fsBody,
    lineHeight: T.lhBody,
    color: BLACK,
  },
  labelInput: {
    flex: 1,
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radCtl,
    paddingHorizontal: dp(14),
    paddingVertical: dp(9),
    fontSize: T.fsBody,
    color: BLACK,
    marginRight: dp(10),
  },
  addBtn: {
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radCtl,
    paddingHorizontal: dp(22),
    height: T.tap,
    justifyContent: 'center',
  },
  addBtnTxt: {fontSize: T.fsBody, fontWeight: '600', color: BLACK},
  sourceRow: {height: T.tap, justifyContent: 'center', marginTop: dp(10)},
  sourceTxt: {fontSize: T.fsBody, color: BLACK, textDecorationLine: 'underline'},

  // Settings
  setRow: {flexDirection: 'row', alignItems: 'center', paddingVertical: dp(14)},
  setLabelBox: {width: dp(260), paddingRight: dp(16)},
  setLabel: {fontSize: T.fsBody, fontWeight: '700', color: BLACK},
  setHint: {fontSize: T.fsMeta, color: BLACK},
  setHintRow: {flexDirection: 'row', alignItems: 'center', marginTop: dp(3)},
  bubbleIcon: {width: dp(24), height: dp(24), marginRight: dp(7)},
  bubbleNote: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: dp(17),
    height: dp(17),
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: dp(3),
  },
  // The plus sits ON the note's bottom-right corner, as the bubble draws it.
  bubblePlusH: {
    position: 'absolute',
    left: dp(11),
    top: dp(16),
    width: dp(12),
    height: dp(2),
    backgroundColor: BLACK,
  },
  bubblePlusV: {
    position: 'absolute',
    left: dp(16),
    top: dp(11),
    width: dp(2),
    height: dp(12),
    backgroundColor: BLACK,
  },
  maxInput: {
    width: dp(68),
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radCtl,
    paddingHorizontal: dp(12),
    paddingVertical: dp(8),
    marginRight: dp(8),
    marginVertical: dp(4),
    fontSize: T.fsBody,
    color: BLACK,
    textAlign: 'center',
  },
  warnTxt: {
    fontSize: T.fsMeta,
    color: BLACK,
    fontStyle: 'italic',
    marginLeft: dp(4),
    flexShrink: 1,
  },
  setCtls: {flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center'},
  setValue: {fontSize: T.fsBody, color: BLACK, marginRight: dp(14)},
  opt: {
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radCtl,
    paddingHorizontal: dp(16),
    paddingVertical: dp(8),
    marginRight: dp(8),
    marginVertical: dp(4),
  },
  optOn: {borderWidth: T.sel, paddingHorizontal: dp(16) - (T.sel - T.hair)},
  optTxt: {fontSize: T.fsBody, color: BLACK},
  optTxtOn: {fontWeight: '700'},

  // Banner
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: T.hair,
    borderColor: BLACK,
    borderRadius: T.radCard,
    paddingHorizontal: dp(14),
    paddingVertical: dp(10),
    marginTop: dp(12),
  },
  bannerTxt: {flex: 1, fontSize: T.fsBody, color: BLACK, marginRight: dp(12)},

  // Ko-fi
  kofiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: T.hair,
    borderTopColor: BLACK,
    paddingTop: dp(12),
    paddingBottom: dp(16),
  },
  kofiText: {fontSize: T.fsMeta, color: BLACK, lineHeight: dp(22)},
  kofiLink: {fontSize: T.fsMeta, fontWeight: '700', color: BLACK, marginTop: dp(2)},
  kofiQr: {
    width: dp(74),
    height: dp(74),
    borderWidth: T.hair,
    borderColor: BLACK,
    marginLeft: dp(14),
  },
});

export default App;
