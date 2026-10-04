# QueryFlow

A lightweight SQL **editor** for BigQuery, PostgreSQL, MySQL and SQL Server that runs entirely in the browser and is meant to be
hosted for free as a static site. See README.md for features, layout and hosting options.

## Ground rules

- **Editor only, no server.** Everything works from the SQL text in the browser: no backend,
  no API calls, no database connection, no login, no AI features. `npm run build` must stay a
  plain static `dist/` that any static host can serve. The one engine is local: the Run tab runs
  BigQuery queries on small test tables with DuckDB-WASM, served from `dist/` itself and loaded
  only on the first run (extension autoloading is switched off, so it never fetches anything).
  Its `.wasm` is ~36 MB (~8 MB gzipped), over Cloudflare Pages' 25 MB per-file limit.
  The one outside request is GoatCounter's anonymous count (script in `index.html`, actions via
  `track()` in `src/stats.js`): event names only, never SQL, and no other trackers.
- **It will be public.** Keep company-internal names, datasets, endpoints and URLs out of
  code, sample queries and docs.
- **Light and fast.** It's for reading and editing 1,000+ line queries. Avoid new dependencies
  and keep anything not needed for first paint lazy-loaded (the formatter and diff dialog are
  loaded with `import()` in `src/main.js`).
- **Git:** `origin` is the public GitHub repo `AbhijeetCodes/QueryFlow`. Every push to `main`
  runs the tests and redeploys https://abhijeetcodes.github.io/QueryFlow/ (GitHub Pages, via
  `.github/workflows/pages.yml`), so a push publishes. Ask before pushing.

## Commands

```bash
npm install
npm run dev      # http://localhost:5199 (also in .claude/launch.json as "queryflow")
npm test         # node --test test/*.test.js
npm run build    # static site in dist/ (relative paths via base: './')
```

## Code map

- `src/dialect.js`: the four dialects (`bigquery`, `postgres`, `mysql`, `sqlserver`) and the editor's current
  one. Dialect differences belong here as data (quoting, params, variables, reserved words, lint
  text) rather than as `if (dialect)` scattered through the code.
- `src/tokenizer.js`: tolerant tokenizer, `tokenize(src, dialect)` (never throws)
- `src/analyzer.js`: `analyzeDoc(doc)` (cached per doc and dialect) gives the CTE/join graph, variables,
  params, filter values, date windows and lint diagnostics. Everything else reads from it.
  `analyze(src, dialect)` is the uncached form tests use; `analysis.dialect` says which one it read.
- `src/shape.js`: per-step summary (filters, aggregates, dedupe, windows)
- `src/scope.js`: alias → FROM item at a position; CTE columns for autocomplete
- `src/symbols.js`: `symbolAt(analysis, pos)` (CTE / table / alias / variable / param and its uses),
  rename edits, CTE preview SQL. `src/symbol-ui.js` puts it in the editor (hover, F12, ⇧F12, F2).
- `src/share.js`: share links (query deflated into the URL `#hash`, never sent to the host)
- `src/format.js`: sqlfluff-style formatting on top of `sql-formatter`; `formatSql(src, dialect, options)`
  takes the ⋯ menu's Formatting choices (keyword case, indent, leading commas, compact lists)
- `src/editor.js`: CodeMirror 6 setup (dialect, marks, lint, folding, completions, sticky CTE header)
- `src/vars-panel.js`, `src/graph-panel.js`, `src/steps-view.js`: right-hand panels
- `src/diff.js`, `src/diff-view.js`: review-before-copy diff
- `src/sample.js`: the example (a short Pokédex query per dialect, on the practice tables). The editor
  starts empty; this loads only from *Load the example* (the empty editor's card or the ⋯ menu).
- `src/main.js`: wiring (toolbar, status bar, themes, resizable panes)
- `src/stats.js`: `track(name)` counts an action on GoatCounter (dashboard kept private). Repo
  traffic history is saved outside this public repo, in a private `QueryFlow-stats` repo.
- Run tab (all lazy-loaded): `src/bq2duck.js` translates BigQuery to DuckDB token by token
  (keeps line numbers; points table names at test tables); `src/testdata.js` parses the CSV / TSV
  test tables, holds the size limits and guesses columns / starter rows from the analysis;
  `src/runner.js` plans and executes a run against any driver; `src/engine.js` is the
  DuckDB-WASM driver. A file too big for a test table is never saved: it stays in the tab's
  memory (`mem` in `run-panel.js`), is loaded once into DuckDB's `memory.qf_files` and each
  run reads it through a view; `src/xlsx.js` reads `.xlsx` imports (no library); `src/practice.js` is the practice database and its example queries (each one is run in `test/run.test.js`); `src/run-panel.js` is the UI. `test/run.test.js` runs the translations on
  DuckDB's Node build, so add a case there for each new translation rule.

Every edit, including edits from the side panels, is a CodeMirror transaction, so one undo
history covers all of them. Saved state uses `localStorage` keys prefixed `queryflow.` (test tables live in
`queryflow.testdata`).
