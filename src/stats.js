// Anonymous usage counts with GoatCounter (no cookies). The page view comes from
// count.js in index.html; this adds action counts. Only the name, such as
// "format/postgres", is sent: never the SQL. count.js skips localhost.
export function track(name) {
  try { window.goatcounter?.count?.({ path: name, title: name, event: true }); } catch { /* blocked */ }
}
