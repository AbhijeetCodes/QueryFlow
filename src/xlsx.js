// A small .xlsx reader for test tables, so Excel files import without a library.
// An .xlsx file is a zip of XML parts: the workbook (sheet names), each sheet's
// cells, the shared strings table and the styles (which say which numbers are
// dates). The zip is inflated with the browser's own DecompressionStream.
// Each sheet becomes CSV text. Loaded only when an Excel file is imported.

import { csvLine } from './testdata.js';

// ---- zip ------------------------------------------------------------------------------

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files in a zip: Map(name -> () => Promise<Uint8Array>). */
export function readZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // End of central directory: scan back over a possible comment (up to 64 KB).
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    files.set(name, async () => {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = u8.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error(`zip compression method ${method} isn't supported`);
    });
  }
  return files;
}

// ---- XML bits --------------------------------------------------------------------------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
  : ENT[e] ?? m));
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unxml(m[1]) : null;
};
// Every <t> inside a string item (rich text runs included), minus phonetic hints.
const textOf = (xml) => {
  let s = '';
  const body = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  for (const m of body.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) s += m[1];
  return unxml(s);
};

// ---- dates ---------------------------------------------------------------------------------

// Built-in number formats that are dates / times.
const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 45, 46, 47]);

function formatKind(code) {
  const c = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, ''); // drop quoted text, escapes and [colours]
  const hasDate = /[dy]/i.test(c) || /(^|[^h:])m{3,}/i.test(c);
  const hasTime = /[hs]/i.test(c) || /AM\/PM/i.test(c);
  if (hasDate && hasTime) return 'datetime';
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  return null;
}

function styleKinds(stylesXml) {
  const custom = new Map();
  for (const m of stylesXml.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)) {
    custom.set(+attr(m[0], 'numFmtId'), attr(m[0], 'formatCode') || '');
  }
  const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(stylesXml)?.[1] || '';
  return [...xfs.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)].map((m) => {
    const id = +(attr(m[0], 'numFmtId') || 0);
    if (custom.has(id)) return formatKind(custom.get(id));
    if (BUILTIN_DATE.has(id)) return id === 22 ? 'datetime' : 'date';
    if (BUILTIN_TIME.has(id)) return 'time';
    return null;
  });
}

const pad = (n) => String(n).padStart(2, '0');
// Excel counts days from 1899-12-30 (serial 25569 is 1970-01-01), or from
// 1904-01-01 in workbooks saved with the 1904 date system.
function serialToText(serial, kind, date1904) {
  const days = serial + (date1904 ? 1462 : 0) - 25569;
  const day = new Date(Math.round(days * 86400) * 1000); // to the nearest second
  const iso = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
  const time = `${pad(day.getUTCHours())}:${pad(day.getUTCMinutes())}:${pad(day.getUTCSeconds())}`;
  if (kind === 'date') return iso;
  if (kind === 'time') return time;
  return `${iso} ${time}`;
}

// 0.30000000000000004 -> 0.3: Excel stores doubles; show what Excel shows.
const cleanNumber = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toPrecision(15)));
};

const colIndex = (ref) => {
  const letters = /^[A-Z]+/i.exec(ref || '')?.[0].toUpperCase() || '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// ---- the workbook ----------------------------------------------------------------------------

const resolvePath = (target, base = 'xl/') => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (base + target).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
  return out.join('/');
};

function sheetRows(xml, shared, kinds, date1904, maxRows) {
  const rows = [];
  let total = 0;
  for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const cells = [];
    let next = 0;
    for (const cm of (rm[2] || '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const tag = cm[1];
      const body = cm[2] || '';
      const ref = attr(' ' + tag, 'r');
      const col = ref ? colIndex(ref) : next;
      next = col + 1;
      const t = attr(' ' + tag, 't') || 'n';
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      let out = '';
      if (t === 's') out = v != null ? shared[+v] ?? '' : '';
      else if (t === 'inlineStr') out = textOf(body);
      else if (t === 'str') out = v != null ? unxml(v) : '';
      else if (t === 'b') out = v === '1' ? 'true' : v === '0' ? 'false' : '';
      else if (t === 'e') out = ''; // #N/A, #DIV/0! … read as NULL
      else if (t === 'd') out = v != null ? unxml(v).replace('T', ' ').replace(/Z$/, '') : '';
      else if (v != null && v !== '') {
        const kind = kinds[+(attr(' ' + tag, 's') || 0)];
        out = kind ? serialToText(Number(v), kind, date1904) : cleanNumber(v);
      }
      cells[col] = out;
    }
    const filled = Array.from(cells, (c) => c ?? '');
    if (!filled.some((c) => c !== '')) continue; // blank rows
    // The first row with cells is the header; keep up to maxRows rows after it.
    if (rows.length && ++total > maxRows) continue;
    rows.push(filled);
  }
  // Trim columns that are empty in every row (formatting often reaches far to the right).
  let width = 0;
  for (const r of rows) for (let i = r.length - 1; i >= width; i--) if (r[i] !== '') { width = i + 1; break; }
  return { rows: rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')), total };
}

/**
 * Read an .xlsx / .xlsm file. Returns [{ name, text, rows, total, truncated }]
 * for each sheet that has cells, in workbook order. `text` is CSV with the
 * sheet's first non-blank row as the header.
 */
export async function readXlsx(buf, { maxRows = 1000 } = {}) {
  let files;
  try { files = readZip(buf); } catch { throw new Error('This isn\'t an .xlsx file (an old .xls? Save it as .xlsx or CSV)'); }
  const dec = new TextDecoder();
  const read = async (name) => (files.has(name) ? dec.decode(await files.get(name)()) : '');
  const workbook = await read('xl/workbook.xml');
  if (!workbook) throw new Error('No workbook inside this file: is it an Excel .xlsx file?');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const relTarget = new Map([...rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\sdate1904="(1|true)"/.test(workbook);
  const sharedXml = await read('xl/sharedStrings.xml');
  const shared = [...sharedXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1]));
  const kinds = styleKinds(await read('xl/styles.xml'));
  const out = [];
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') || `Sheet${out.length + 1}`;
    const rid = attr(m[0], 'r:id') || attr(m[0], '[\\w]+:id');
    const target = relTarget.get(rid);
    if (!target) continue;
    const xml = await read(resolvePath(target));
    if (!xml) continue;
    const { rows, total } = sheetRows(xml, shared, kinds, date1904, maxRows);
    if (!rows.length) continue;
    out.push({ name, text: rows.map((r) => csvLine(r)).join('\n') + '\n', rows: rows.length - 1, total, truncated: total > maxRows });
  }
  return out;
}
