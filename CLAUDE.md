# QueryFlow

A lightweight BigQuery SQL **editor** that runs entirely in the browser and is meant to be
hosted for free as a static site. See README.md for features, layout and hosting options.

## Ground rules

- **Editor only, no server.** Everything works from the SQL text in the browser: no backend,
  no API calls, no BigQuery connection, no login, no AI features. `npm run build` must stay a
  plain static `dist/` that any static host can serve.
- **It will be public.** Keep company-internal names, datasets, endpoints and URLs out of
  code, sample queries and docs.
- **Light and fast.** It's for reading and editing 1,000+ line queries. Avoid new dependencies
  and keep anything not needed for first paint lazy-loaded (the formatter and diff dialog are
  loaded with `import()` in `src/main.js`).
- **Git:** local repo with no remote yet. Ask before creating a remote, pushing or deploying.

## Commands

```bash
npm install
npm run dev      # http://localhost:5199 (also in .claude/launch.json as "queryflow")
npm test         # node --test test/*.test.js
npm run build    # static site in dist/ (relative paths via base: './')
```

## Code map

- `src/tokenizer.js`: tolerant GoogleSQL tokenizer (never throws)
- `src/analyzer.js`: `analyzeDoc(doc)` (cached per doc) gives the CTE/join graph, variables,
  params, filter values, date windows and lint diagnostics. Everything else reads from it.
- `src/shape.js`: per-step summary (filters, aggregates, dedupe, windows)
- `src/scope.js`: alias → FROM item at a position; CTE columns for autocomplete
- `src/symbols.js`: `symbolAt(analysis, pos)` (CTE / table / alias / variable / param and its uses),
  rename edits, CTE preview SQL. `src/symbol-ui.js` puts it in the editor (hover, F12, ⇧F12, F2).
- `src/share.js`: share links (query deflated into the URL `#hash`, never sent to the host)
- `src/format.js`: sqlfluff-style formatting on top of `sql-formatter`
- `src/editor.js`: CodeMirror 6 setup (dialect, marks, lint, folding, completions, sticky CTE header)
- `src/vars-panel.js`, `src/graph-panel.js`, `src/steps-view.js`: right-hand panels
- `src/diff.js`, `src/diff-view.js`: review-before-copy diff
- `src/main.js`: wiring (toolbar, status bar, themes, resizable panes)

Every edit, including edits from the side panels, is a CodeMirror transaction, so one undo
history covers all of them. Saved state uses `localStorage` keys prefixed `queryflow.`.
