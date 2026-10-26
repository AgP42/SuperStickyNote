# Changelog

Public releases only. Each one is a `.snplg` on the
[Releases page](https://github.com/AgP42/SuperStickyNote/releases).

> **Firmware:** Plugin version **v1.0.0 and later** need **Chauvet 3.29.43 (Manta/Nomad) /
> 2.26.40 (A5 X / A6 X)** minimum. Devices on an earlier Chauvet need **v0.9.1**. A build
> for one firmware doesn't run on the other.

## v3.1.0 — 2026-10-26

Handwriting arrives in SuperStickyNote: write on a sticky note with the pen, erase, and
put it back on the page as real strokes.

### Two kinds of sticky notes
- **Settings → Mode**: **Handwriting** or **Text (OCR)**. It decides what *new* sticky
  notes are; each note keeps the kind it was born with, and both kinds live side by side
  in the list and on screen.
- **Handwriting mode**: the bubble ✚ opens a sticky note ready to write on with the pen,
  and a lasso capture brings the strokes themselves into the sticky note.
- **Text mode**: as before — the keyboard, and a lasso capture is recognised (OCR).
- A **PDF text selection** always makes a text note: it is already text.

### Writing on a sticky note
- A handwritten sticky note is **grey with "✎ Write here"** while nobody writes on it.
  Tap **✎**, hold the pen over it, or just start writing on it, and it turns white and
  framed: write, then tap
  **✓**. The ink shows live, as fast as in a notebook, and nothing lands on the page
  under the card. *Starting by writing on it: that first stroke still goes to the page —
  tap ✎ first to avoid it.*
- The writing area is the **whole card**, and the card writes with **the pen selected in
  the notebook**: same pen, size and grey.
- **Erase and undo** with the eraser (or the pen's eraser end) and ↶ in the card's header. *Use those, not the
  notebook's two-finger eraser gesture: the system applies it to the page under the card.*
- Lassoed handwriting is **strokes in the card**, like what you write there: erase parts
  of it, write over it.
- Writing ends when you tap ✓, touch the page with the pen outside the card, close the
  card or open the Manager. The pen always goes back to the notebook with its own pen.
- A new handwritten sticky note closed or hidden with nothing on it is discarded; an older one
  erased to nothing is kept, with its title and labels.

### Back on the page
- **Put on page** (the clipboard in the card's header, or the Manager's button) puts the
  sticky note on the displayed notebook page: its handwriting as **real strokes** — lasso
  them, move them, erase them like anything you wrote, on a notebook **or a PDF** — or else
  its text as a text box (notebooks only: a PDF has no text boxes).
- **Export all (.txt)** skips handwritten notes: they have no text.

### A cleaner card
- All the card's tools are in its header, drawn as one set: put on page, ✎, ✕ — and
  eraser, undo, ✓ while writing.
- A bin at the bottom-left deletes the sticky note from the card itself (a second tap
  confirms); ✕ still only closes it.
- New sticky notes get the plugin's own icon, a note with a folded corner (notes that had
  the old ✎ default get it too).
- A handwritten note shows no "Untitled": give it a title in the Manager if you want one.
  Folded, an untitled one says "Handwritten note".

### Manager and backup
- On a handwritten note's page, **✎ Write** (or a tap on the handwriting) brings its
  sticky note up over the Manager, ready to write on. The pen no longer leaves ink on
  the Manager, where nothing was saved.
- **Export .json** now carries the handwriting too, in a `SuperStickyNote-ink` folder next
  to the backup; **Import .json** puts it back.
- **Delete** asks for a second tap.
- **Search** also looks in labels.
- A lasso in Handwriting mode says when it left out pictures, text boxes or links.

### Not yet
- Searching handwriting (use labels and titles).

How it works: the card borrows the pen from the notebook through Supernote's firmware ink
service, the same one the notebook uses when a plugin opens. The binder contract is
ported from [sn-canvas](https://github.com/j-raghavan/sn-canvas) (MIT, © 2026 JRaghavan).
Tested on the Manta.

## v2.0.0 — 2026-09-20

The Manager is redrawn in the device's own visual language, capture works in documents as
well as notebooks, and a sticky note's text can go back onto the page.

### Capture from a page
- **PDF and EPUB text** → sticky note: select it, tap **Add to StickyNote** in the
  selection toolbar. No recognition needed — the text is already text.
- **Handwritten annotations on a PDF** capture with the lasso, exactly like notebook
  handwriting.
- **Underline a word** inside your lasso selection with the straight-line tool and it
  becomes a **label** on the new sticky note. Three underlined words, three labels. No
  underline, nothing happens.
- **Frame on capture** now works on documents too — it is a drawn shape, which a PDF
  accepts (only text boxes are notebook-only).

### Back to the page
- **Insert in note** puts a sticky note's text on the notebook page as an editable text
  box, in the **Font** and **Text size** from Settings.
- The clipboard **Paste** is gone from the Manager: since Android 10 only the focused app
  may read the clipboard, which a plugin never is. **Copy** still works.

### The Manager, rebuilt
- A **left rail** of filters — All, On screen, Untagged, one row per label — each with its
  count, replacing the chips above the list.
- **Search** is always visible; the list is **paged** instead of one long scroll, which
  suits e-ink far better.
- A note's actions appear **under the note itself** when you select it, instead of seven
  buttons on every row.
- **Configuration** and **Backup** become a **Settings** screen, reachable from the rail.
- Hairline frames, dotted rules and no black fills, measured off the device's own screens:
  the panel now sits beside the native apps instead of shouting over them.

### Settings
- **Fonts from `MyStyle/fonts` are shown in their own typeface** — pick by looking, not by
  reading a file name.
- **Sticky notes on screen** is now yours to set: 8 by default, anything from 1 to 40, with
  a warning past 8 (every floating note is a system window).
- The default icon for a new sticky note is the **pencil**.

### Fixes
- **Typing in a sticky note no longer rewinds the caret.** Text streamed to the store came
  back late and was written over what you were typing, scrambling the sentence.
- **Editing the same note in its card and in the Manager no longer loses either edit**, and
  an edit made in the Manager reaches the floating card while you type it.
- The card icon and the resize handle are **finger-sized** (they were drawn for the pen).
- Label chips in the list are legible again, and captured notes show the **right page
  number** (the firmware counts from 0, readers count from 1).
- Many fewer round trips between the plugin and its overlays: typing, hiding all notes and
  opening Settings no longer repaint every floating card.

## v1.1.1 — 2026-09-04

- **Lasso → Add to StickyNote** works on selections containing geometry (Smart Straight
  Line, plugin-inserted shapes); the button used to be missing for those.
- **Text wins over shapes**: shapes are filtered out before recognition, so a line beside
  your notes can no longer make the recognizer return nothing.
- A **shape-only** selection still makes a sticky note, describing what it found —
  `2 × Circle`, `Rectangle`, `Polygon (5 sides)`.

## v1.0.0 — 2026-08-27

Rebuilt for **Chauvet 3.29.43 / 2.26.40** and its new plugin permission system.

- The **lasso clears itself** after a capture — no need to pick the pen back up to tap away.
- **↪ Source backlink**: every sticky made from handwriting remembers its page, and jumps
  (or reopens the note/PDF/EPUB) right back to it.
- **Frame** — optionally draw a thin box on the note around the captured text: Black,
  Grey 1, Grey 2.

## v0.9.1 — 2026-08-16

- **Show / hide the ✚ bubble**, so the launcher doesn't have to float over your pages.
- **Configuration** — Text size, Font and Bubble tuck under one collapsible line; Backup
  stays visible.

## v0.9.0 — 2026-08-16

- **Labels** with a Manager filter (match all selected labels, an Untagged filter) and
  **search**.
- **Lasso → Add to sticky**: OCR handwriting straight into a new sticky note.
- Edit a note's **text, icon and labels** from the list, with Copy / Paste.
- **Fonts** — Sans / Serif / Mono plus your own from `MyStyle/fonts`; **text size** XS→XXL.
- Sticky notes stay **on top of the Manager**, so font and size changes preview live.
- **Backup/restore**: `.txt` per note, a `.json` snapshot, and an import that **merges**.

## v0.5.0 — 2026-08-16

- Edit any note inline from the Manager: tap **Edit** on a row for a text editor, saved as
  you type.

## v0.4.6, v0.4.1, v0.4.0 — 2026-08-15

First public previews: floating sticky notes over NOTE and DOC, keyboard editing, the ✚
launcher bubble, and notes kept in the plugin's own private storage.
