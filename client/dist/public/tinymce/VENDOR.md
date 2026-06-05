# Vendored TinyMCE (self-hosted)

The rich-text editor on the **My Nets** page uses TinyMCE, served locally from this
directory. There is **no Tiny Cloud account or API key** — the editor loads entirely
from this instance (`/tinymce/tinymce.min.js`, wired up in
`server/dist/views/partials/featureTinyMceJs.ejs`).

- **Version:** TinyMCE 6.8.6
- **License:** GPL-2.0-or-later (see `license.txt`). The MIT license of this project
  applies to Ham.Live's own code; TinyMCE retains its own license.
- **Source:** the official `tinymce` npm package — <https://www.npmjs.com/package/tinymce>

## What's vendored (and why)

Only the runtime pieces the editor config actually uses are included, to keep the repo
small. The editor is initialized in `client/dist/public/js/byView/myNets/main.js` with:
`skin_url: '/tinymce/skins/hl'`, `content_css: 'dark'`, `plugins: 'lists'`,
`toolbar: 'bullist italic'`.

| Path | Purpose |
| --- | --- |
| `tinymce.min.js` | Core |
| `themes/silver/` | Default theme |
| `models/dom/` | DOM model |
| `icons/default/` | Toolbar icons |
| `plugins/lists/` | The one plugin used (`bullist`) |
| `skins/content/dark/` | `content_css: 'dark'` styling |
| `skins/hl/` | Custom Ham.Live UI skin (hand-built, kept from the hosted app) |

The default `oxide` UI skin is intentionally **not** vendored because `skin_url` points at
the custom `hl` skin instead.

## Updating / re-vendoring

```bash
npm pack tinymce@^6                 # downloads tinymce-<version>.tgz
tar xzf tinymce-*.tgz              # extracts to ./package
DST=client/dist/public/tinymce
cp package/tinymce.min.js                       "$DST/"
cp package/themes/silver/theme.min.js           "$DST/themes/silver/"
cp package/models/dom/model.min.js              "$DST/models/dom/"
cp package/icons/default/icons.min.js           "$DST/icons/default/"
cp package/plugins/lists/plugin.min.js          "$DST/plugins/lists/"
cp package/skins/content/dark/content.min.css   "$DST/skins/content/dark/"
cp package/license.txt                          "$DST/"
```

If you add TinyMCE plugins to the editor config, copy the matching `plugins/<name>/`
directory here too.
