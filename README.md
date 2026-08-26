# SuperStickyNote

Floating sticky quick-notes for Supernote e-ink devices. A small **✚ bubble** floats
over everything; tap it and a **sticky note** appears on top of your notebook or document.
Write with the keyboard, drag it around, keep several open at once — your thoughts land
on the page without ever leaving what you were doing.

![SuperStickyNote in action](docs/screenshots/hero.png)

## Features

- Floating sticky notes over the **NOTE** and **DOCUMENT** apps — up to **8 on screen**, overlapping
- **Single-tap** inline keyboard editing, auto-saved; **collapse**, **move**, **resize**, long notes scroll
- **Labels** with a filter (and an "Untagged" filter); **search**
- **Lasso → Add to StickyNote**: OCR handwriting straight into a new sticky note. The lasso **clears itself** once captured, an optional **frame** (black or grey) can be drawn around the text on the note, and each note keeps a **↪ Source** backlink to jump/open the page it came from
- Edit a note's **text, icon and labels** from the list, with **copy / paste**
- **Text size** XS→XXL and **fonts** (Sans/Serif/Mono + your own from `MyStyle/fonts`); **show/hide** the ✚ bubble; **frame** captured text — all under a collapsible **Configuration** section
- Live preview: open sticky notes stay on top of the Manager, so font/size changes show in real time
- **Export** to `.txt`, **backup/restore** to `.json` (import merges, never overwrites)
- Notes stored **privately** (not cloud-synced)

> Text only for now — handwriting inside a sticky note isn't supported yet.

> **Which version do I need?** Supernote's firmware is called *Chauvet* — that's the
> platform name, so what matters is the version number (check it in device settings). This
> release (**v1.0.0**) targets **Chauvet 3.29.43 (Manta/Nomad) / 2.26.40 (A5 X / A6 X) or
> later** — the developer-preview builds that add the new plugin permission system and other
> breaking plugin-API changes. A build made for one firmware version doesn't run on the
> other: devices on an earlier Chauvet need the previous release, and once these versions
> ship widely v1.0.0 becomes the main build. Installing the wrong one shows *"package not
> compatible"* or the plugin does nothing. Verified on Nomad.

## Demos

**Lasso handwriting → sticky note (OCR)**

![Lasso to sticky](docs/lasso-demo.gif)

**Frame the captured text on the note (black or grey) — each sticky keeps a ↪ Source backlink**

![Framed captures on the note](docs/screenshots/frame-on-note.png)

**Sticky note → note → export**

![Sticky note to note and export](docs/sticky-to-note-export-demo.gif)

## Install

1. Copy `superstickynote-<version>.snplg` (see [Releases](../../releases/latest)) to `MyStyle/` on the device.
2. **Settings → Apps → Plugins → Add Plugin** → pick the file.
3. Open a notebook — the ✚ bubble appears.

## Documentation

See the **[User Guide](USER_GUIDE.md)** for the full walkthrough and gesture reference.

## Build

```bash
npm install
./buildPlugin.sh        # → build/outputs/SuperStickyNote.snplg
```
React Native 0.79.2 + `sn-plugin-lib`. The native overlay bridge is in
`android/app/src/main/java/com/superstickynote/`.

## Support

Free & made with love by a Supernote user, for Supernote users.
☕ **https://ko-fi.com/agp42**
