# <img src="public/logo.svg" width="28" height="28" alt="" align="top"> QueryFlow

A fast, lightweight SQL editor for **reading and editing** big BigQuery queries,
right in the browser. Paste an old query and it formats it, draws how the tables
join, and lists every variable and hardcoded filter value so you can change them
in one place, then copy the SQL back into BigQuery.

Everything runs client-side from the SQL text: no server, no login, no database
connection. Your query never leaves the browser (it's kept in `localStorage`).
That makes it a plain static site you can host anywhere for free.

## Run locally

```bash
npm install
npm run dev        # http://localhost:5199
```

`npm test` runs the analyzer and formatter tests. `npm run build` writes the static site to `dist/`.

## Host it for free

`npm run build` produces a static `dist/` folder with relative paths, so it works at a
domain root or under a sub-path. Any static host will do:

| Host | Free URL | Setup |
|---|---|---|
| **GitHub Pages** | `<user>.github.io/QueryFlow` | Push to GitHub, then *Settings → Pages → Source: GitHub Actions*. `.github/workflows/pages.yml` builds and deploys on every push to `main`. |
| **Cloudflare Pages** | `queryflow.pages.dev` | *Workers & Pages → Create → Pages → Connect to Git*. Build command `npm run build`, output directory `dist`. |
| **Netlify** | `queryflow.netlify.app` | *Add new site → Import from Git*, or drag the `dist/` folder onto app.netlify.com/drop. Build command `npm run build`, publish directory `dist`. |
| **Vercel** | `queryflow.vercel.app` | *Add New → Project*, framework preset *Vite*. |

All of them can also serve a custom domain you own.

## Layout

| Left | Right top | Right bottom |
|---|---|---|
| Editor: BigQuery highlighting, lint squiggles, folding, autocomplete, and a sticky header naming the CTE you're scrolled into | **Variables** (`DECLARE`), **@parameters**, **hardcoded filter values**, **date windows** | **Steps** (the query as a top-to-bottom recipe), **Graph** (tables → CTEs → output) and a **Tables** list |

## Things to try

- **Paste a whole query** → it is auto-formatted (⌘Z shows the original). You can turn this off with "Format on paste" in the ⋯ menu (which also has Paste & format, the sample query, Clear and the theme).
- **Edit a value on the right** → every occurrence in the SQL changes as you type.
- **→ Variable** on a hardcoded value or `@param` → adds `DECLARE v_x TYPE DEFAULT …;` at the top and replaces every occurrence.
- **use start_date** appears when a hardcoded value equals an existing variable's value.
- **Hover** a row to highlight its uses. **Click** a name or the `×N` count to jump through them.
- **Click a graph node** → jumps to it in the SQL, dims unrelated lineage, and shows its joins with ON conditions. Click again to cycle through references.
- **Steps tab**: one card per CTE / output in execution order. Each card lists what it reads (join type and keys), what it does (filters, aggregation, dedupe, window, union, limit) and what it feeds. FROM-subqueries are nested inside the step that uses them.
- **Derived tables**: a CTE or subquery built from a single input gets a thick "derived" edge in the graph, a "from X" subtitle, and chips such as `filter 2`, `Σ by product_id` or `latest per product_id`. The last one is the `ROW_NUMBER() … rn = 1` dedupe pattern, found in QUALIFY, WHERE or the join's ON.
- **Graph → filters**: click a node (or a step name in Steps) and the filter panel shows only that step's hardcoded values, including those in its nested subqueries. Variables it doesn't use are dimmed. Each value has a step tag; click it to jump to that node. "show all" resets.
- **Focus lineage**: double-click a node, or use "focus lineage" in its card, to draw only what feeds it and what it feeds.
- **Subquery filters**: `WHERE x IN (SELECT … FROM T)` and `EXISTS (…)` only keep or drop rows; they don't bring in data. They show as an `in T` chip on the node instead of an edge, which keeps graphs readable when many CTEs filter by the same base CTE. "Show links" in the graph toolbar draws them as dotted edges.
- **Params CTEs**: a CTE with no FROM, like `params AS (SELECT DATE '2025-01-01' AS start_date, 'SG' AS country)`, is treated as a set of constants. Its values are editable in the Variables panel, with the comment next to each value shown as a hint. Its cross-join edges are hidden, and each step that reads it gets a `uses params` chip. Cross-joining it doesn't trigger the comma-join warning, since it's a single row.
- **→ all to variables**: one click turns every hardcoded filter value into a `DECLARE`. An all-literal `IN (…)` list becomes an ARRAY variable used as `IN UNNEST(v)`, and a value equal to an existing variable reuses it. One ⌘Z undoes it.
- **Date windows**: every date bound in WHERE / ON / HAVING / QUALIFY is resolved to a day, whether it comes from a literal, a DECLARE variable, a params CTE value, `DATE_SUB(…, INTERVAL n DAY)` or `CURRENT_DATE()`. From these each step gets a window. The *Date windows* section, the lint and the date chips on graph nodes flag a step whose start or end differs from the others. They also flag a partition filter (`_PARTITIONDATE`, `_PARTITIONTIME`, `_TABLE_SUFFIX`) that is narrower than the window, which silently drops rows, and one far wider than needed (extra bytes). Steps that share the same window and have no issue collapse into one row; click a date to step through them. "align" fixes a mismatched hardcoded date. Exclusive bounds count as inclusive days: `< '2024-04-01'` ends on 03-31.
- **Review before copy**: when you paste a whole query, QueryFlow remembers it (after auto-format) as the original. If you've changed it since, **Copy** (the copy icon on the editor toolbar, or ⌘⇧Enter) first shows a diff: removed and added lines, with the changed part of each line highlighted and unchanged stretches folded. Enter copies the edited SQL; you can also *Copy original* or *Mark current as original*. The **Changes +N −N** button on the toolbar opens the same view at any time. Untick "Always review before copying" to copy straight away.
- **Window functions**: each one gets a card in the graph's node detail and in Steps. The card shows the output column, what it computes in plain words (*running sum*, *rolling avg*, *dense rank*, *previous value*, *count per group*…), its **per** (PARTITION BY) and **order** (ORDER BY, ↑ asc / ↓ desc) keys, and any frame. Named windows (`OVER w`, `WINDOW w AS (…)`) are resolved. Click a card to select the expression in the editor. `LAST_VALUE` with ORDER BY and the default frame is flagged, because it returns the current row's value.
- **Hover a node** to light up only it and its direct inputs, to see how that table was built.
- **Graph direction**: `auto` picks left-to-right or top-to-bottom, whichever fits the panel better. Click it to force one.
- **Light / dark**: the ⋯ menu at the right of the editor toolbar. It follows your system setting until you pick one.
- **Fold** CTE bodies from the gutter (▾) to collapse a 500-line query down to its outline.
- **Joins that change the numbers**: two lint warnings for silent wrong answers.
  - *An outer join undone later*: a `WHERE` condition on a LEFT JOIN's columns (`WHERE b.status = 'x'`), or a later INNER JOIN on them, is false for the rows the LEFT JOIN kept with NULLs, so it drops them and the LEFT JOIN works as an INNER JOIN. Conditions that handle NULL (`IS NULL`, `OR`, `COALESCE`, `IFNULL`, `IF`, `CASE`) aren't flagged. RIGHT and FULL joins are checked the same way.
  - *Fan-out added up*: a CTE with one row per `(user_id, day)` (its GROUP BY, or a `QUALIFY ROW_NUMBER() … = 1` dedupe) joined on `user_id` alone matches each row several times. That's normal for a one-to-many join, so it's only flagged when a `SUM`, `AVG`, `COUNT` or `COUNTIF` in that step adds up columns of the repeated side. `COUNT(DISTINCT …)`, `MIN` and `MAX` are safe.

## Keyboard

| Keys | Action |
|---|---|
| ⌘⇧F or ⌘S | Format |
| ⌘⇧Enter | Copy SQL (reviews the diff first if you've edited the pasted query) |
| ⌘⇧M | List all problems |
| ⌘Z / ⌘⇧Z | Undo / redo, including edits made from the side panels |
| ⌘F | Find and replace |

## How it fits together

| File | Role |
|---|---|
| `src/tokenizer.js` | Tolerant GoogleSQL tokenizer; never throws |
| `src/analyzer.js` | Heuristic analysis: CTEs, joins, variables, filter values, date windows, lint |
| `src/shape.js` | What each step does (filters, aggregation, dedupe, windows) |
| `src/scope.js` | Which table or CTE an alias means at a position; CTE columns for autocomplete |
| `src/format.js` | sqlfluff-style formatting on top of `sql-formatter` (loaded on first use) |
| `src/editor.js` | CodeMirror setup: dialect, marks, lint, folding, completions |
| `src/vars-panel.js` | Variables, parameters, filter values and date windows panel |
| `src/graph-panel.js`, `src/graph-layout*.js` | Lineage graph (dagre; big graphs lay out in a Web Worker) and Tables list |
| `src/steps-view.js` | Steps tab |
| `src/diff.js`, `src/diff-view.js` | Review-before-copy diff |
| `src/main.js` | Wires it together: toolbar, status bar, theme, panes |
