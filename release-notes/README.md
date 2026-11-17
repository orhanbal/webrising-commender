# Release notes ("Yenilikler")

`notes.json` is the one source of the "what's new" notes. They ship inside the
apps (no network needed) and appear in four places:

- **Windows app:** once after an update, in a small "Yenilikler" window; any
  time from the tray menu, Settings and the Dock's settings panel.
- **macOS app:** once after an update, in a small window; any time from the
  menu bar menu, the panel and Settings.
- **Website:** `/changelog` (footer link "Yenilikler"; also in the sitemap and `/llms.txt`).
- **GitHub releases:** the newest entry for the platform (Turkish and
  English) is added to the text of `ubuntu-preview-N` (Windows) and
  `macos-preview-N` releases.

## Adding notes for a release

1. Add an entry at the **top** of `releases` (newest first):

   ```json
   {
    "id": "2026-12-01-windows",
    "date": "2026-12-01",
    "platforms": ["windows"],
    "items": {
     "tr": ["Kısa, sade bir cümle."],
     "en": ["..."], "de": ["..."], "fr": ["..."], "es": ["..."], "pt-BR": ["..."]
    }
   }
   ```

   - `id`: unique, starts with the date (`YYYY-MM-DD`, then optionally `-name`).
     Never change or reuse an id once it has shipped.
   - `platforms`: `["windows"]`, `["macos"]`, or leave it out (or `[]`) for both apps.
     When a release has different notes per app, write two entries with the
     same date (`2026-12-01-windows`, `2026-12-01-macos`).
   - `items`: short, plain, user-facing sentences; no technical detail. All six
     languages, the same number of sentences in each (Turkish is the source).
2. Run `python3 scripts/gen-release-notes.py` (it checks the file and updates
   the macOS and website copies), then commit everything it wrote.
   CI runs it with `--check` (gateway job and the macOS workflow).

## How the apps decide what to show

Builds are numbered per platform (`ubuntu-preview-N` and `macos-preview-N`
differ), and the number is not known when a note is written, so notes are not
tied to build numbers. Each app remembers the id of the newest note it has
shown (`lastSeenNotes` in its settings.json):

- **fresh install** (no settings yet): nothing is shown; the newest id is remembered;
- **after an update**: every entry for this platform above the remembered id
  is shown once (at most five); "Tamam" or closing the window remembers the newest;
- **no new entry**: nothing is shown.

An update therefore shows the notes it carries that the person has not seen,
however many builds were skipped. If an id is removed from the list, the date
at the start of the remembered id is used instead.
