# SuperStickyNote for Supernote — User Guide

Floating sticky quick-notes for your Supernote. A small **✚ bubble** floats over
everything; tap it and a **post-it** appears on top of your notebook or document.
Write with the keyboard, drag it around, keep several open at once — your thoughts
land on the page without ever leaving what you were doing.

> Works inside the **NOTE** and **DOCUMENT** apps. Notes are plain text (handwriting
> inside a post-it is not supported yet). Tested on Manta (A5 X2) and A5 X.

![SuperStickyNote in action](docs/screenshots/hero.png)

---

## 1. Install

1. Copy `superstickynote-<version>.snplg` to the `MyStyle/` folder on the device
   (via USB, or `adb push … /storage/emulated/0/MyStyle/`).
2. On the device: **Settings → Apps → Plugins → Add Plugin** → pick the file.
3. Open a notebook. The **✚ bubble** appears (top-right by default).

**Overlay permission.** Post-its float using the system overlay permission. If they
don't appear, open the plugin from the toolbar and tap **Grant** on the banner, then
allow "Display over other apps" for the plugin host.

*Updating:* uninstall the old version first (Settings → Apps → Plugins), then add the new `.snplg`.

> **After removing the plugin, the ✚ bubble stays on screen** until you **restart the
> device** — the bubble is a system overlay owned by the plugin host, cleared when the
> process is recycled.

---

## 2. The bubble

The **✚ bubble** is always within reach.

- **Tap ✚** → creates a new post-it and opens the keyboard right away.
- **Drag** the bubble to move it anywhere.

---

## 3. The post-it

A post-it floats on top of the page. The rest of the screen stays live — you can keep
writing in your notebook in the gaps between post-its.

| Gesture | What it does |
|---|---|
| **Tap the body** | Edit — the keyboard opens and you type inline |
| **✓ (top-right)** | Finish editing — closes the keyboard |
| **Tap the header bar** | Collapse / expand (collapsed shows only the first line as the title) |
| **Tap the icon** | Open the full list (Manager) |
| **Tap the labels** | Open the Manager (when the post-it has labels) |
| **Drag the header** | Move the post-it |
| **Drag the ◢ corner** | Resize (bottom-right) |
| **Long-press the body** | Copy / Paste bar |
| **✕ (top-right)** | Close the post-it (it stays saved in the list) |

- **Saving is automatic** — text is saved as you type; tapping outside the post-it also closes the keyboard.
- The **first non-empty line** becomes the title (shown when collapsed and in the list).
- **Labels** you add (in the Manager) show as chips in the header, display-only.
- **Long notes** fill the whole card and scroll — drag the ◢ corner to make the card bigger.
- Up to **8 post-its on screen at once** (they overlap freely). At 8, adding another shows a reminder instead of removing one. **No limit** on total notes.
- **Drag with a finger, not the pen** — see *Good to know* below.

---

## 4. The full page (Manager)

Open it from the **toolbar button**, or by **tapping a post-it's icon or labels**.

![The Manager](docs/screenshots/manager.png)

Your open post-its **stay on top of the Manager**, so changing the font or text size
updates them **live**, and opening a note doesn't close the panel.

- **＋ New note** — pick an icon, a fresh post-it floats on the page.
- **Search** — filter by text; tap the **✕** to clear.
- **Labels filter** — tap labels to filter (a note must match **all** selected labels);
  **Untagged** finds notes with no labels; **Clear** resets. Combines with search.

![Search and label filter](docs/screenshots/manager-search.png)

**Per-note actions** (each row):

- **Edit icon** — pick an icon (symbols and digits 0–9). *Shortcut: tap the row's icon.*
- **Edit text** — a text editor with **Copy**, **Paste** and **Done**. *Shortcut: tap the title or preview.*
- **Edit labels** — add labels (type + **Add**, or tap a suggestion); tap a label chip to remove it. *Shortcut: tap the labels by the title.*
- **On screen / Closed** — one button that shows the state **and** toggles it (solid = floating, outline = closed).
- **Export / Delete** (bottom-right) — save the note as `.txt`, or remove it.

![Editing a note's icon and labels](docs/screenshots/edit-icon-labels.png)

**Text size & Font** (bottom of the Manager):

- **Text size** — XS · S · M · L · XL · XXL, applied to every post-it.
- **Font** — **Sans / Serif / Mono**, plus any font you've dropped in `MyStyle/fonts`
  (e.g. handwriting fonts). Applies to the post-it text.

---

## 5. Lasso handwriting into a sticky (OCR)

In a **notebook (NOTE)**, lasso some handwriting, then tap **Add to sticky** in the
lasso toolbar. The selection is recognized (OCR) and dropped into a **new post-it**.
Recognition takes a few seconds — a "Recognizing…" message shows while it works.

![Lasso → Add to sticky](docs/lasso-demo.gif)

---

## 6. Sticky → note, and export

![From a sticky to the note, then export as .txt](docs/sticky-to-note-export-demo.gif)

- **Into a note:** open a post-it, **long-press → Copy**, then paste it into a text box
  on your notebook page.
- **Export a note:** the **Export** button on a row saves that note as a `.txt`.
- **Backup / restore all** (bottom of the Manager):
  - **Export all (.txt)** — one text file per note.
  - **Export .json** — a single `SuperStickyNote-notes.json` snapshot of everything.
  - **Import .json (add)** — reads that backup and **adds** any notes you don't already
    have. It **never overwrites** existing notes, so it's safe.

Exports go to `MyStyle/Plugins/SuperStickyNote/` (visible over USB/MTP).

---

## 7. Where your notes live

Your notes live in the plugin's **private, hidden** storage (not in a synced folder),
so cloud sync can't corrupt them. Backups and exports go to the visible
`MyStyle/Plugins/SuperStickyNote/` folder.

---

## 8. Good to know / limits

- **Text only** — handwriting inside a post-it isn't supported yet.
- **8 post-its** can float at once; total notes are unlimited.
- **Lasso → Add to sticky** works in **NOTE** files only; OCR takes a few seconds.
- **Drag post-its with a finger, not the pen** — moving a post-it with the pen also
  draws on the note underneath (the Supernote pen has a hardware path into the notebook
  that a plugin overlay can't intercept). Finger drag is unaffected.
- **Custom fonts** from `MyStyle/fonts` render on the **post-it**; the Manager list shows
  their names (it can't preview arbitrary font files).
- **Uninstalling leaves the ✚ bubble on screen** — **restart the device** to clear it.
- If a post-it ever gets stuck after a firmware hiccup, force-stopping the plugin host
  (or restarting the device) clears any stray window.

---

## 9. Support

SuperStickyNote is free and made with love by a Supernote user, for Supernote users.
If it earns a spot on your screen, you can buy me a coffee:

**https://ko-fi.com/agp42**
