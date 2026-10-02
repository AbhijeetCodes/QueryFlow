// The built-in .xlsx reader: a workbook saved by openpyxl (inline strings,
// deflated zip) and a hand-built one shaped like Excel's own files (shared
// strings, built-in date formats, x: prefixes, stored zip).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readXlsx } from '../src/xlsx.js';
import { inspectTable } from '../src/testdata.js';

const fixture = readFileSync(new URL('./fixtures/sample.xlsx', import.meta.url));

test('reads every sheet with cells, in order, as CSV', async () => {
  const sheets = await readXlsx(fixture);
  assert.deepEqual(sheets.map((s) => s.name), ['orders', 'Sheet2']); // the empty sheet is skipped
  const [orders] = sheets;
  assert.equal(orders.rows, 3);
  assert.deepEqual(inspectTable(orders.text).names, ['order_id', 'user_id', 'amount', 'created_at', 'order_date', 'paid', 'note']);
  const lines = orders.text.split('\n');
  assert.equal(lines[1], '1,1,10.5,2024-01-03 10:00:00,2024-01-03,true,"first, with comma"');
  assert.equal(lines[2], '2,1,20,2024-01-20 11:30:15,2024-01-20,false,'); // a dd/mm/yyyy cell still reads as an ISO date
  assert.match(orders.text, /0\.3,2024-02-01 09:30:00,2024-02-01,true,"say ""hi""\nnext line"/);
});

// ---- a minimal zip writer (stored entries) for hand-built workbooks ----------------------

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (u8) => { let c = ~0; for (const b of u8) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return ~c >>> 0; };
function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, n.length, 2]]
      .forEach(([at, v, size]) => (size === 4 ? local.setUint32(at, v, true) : local.setUint16(at, v, true)));
    parts.push(new Uint8Array(local.buffer), n, data);
    const c = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, n.length, 2], [42, offset, 4]]
      .forEach(([at, v, size]) => (size === 4 ? c.setUint32(at, v, true) : c.setUint16(at, v, true)));
    central.push(new Uint8Array(c.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out.buffer;
}

const NS = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function excelBook(sheetXml, { date1904 = false } = {}) {
  return zip({
    'xl/workbook.xml': `<x:workbook ${NS}><x:workbookPr${date1904 ? ' date1904="1"' : ''}/><x:sheets><x:sheet name="Q1 Orders" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<x:sst ${NS}><x:si><x:t>id</x:t></x:si><x:si><x:t>when</x:t></x:si><x:si><x:t>at</x:t></x:si><x:si><x:t>who</x:t></x:si>`
      + '<x:si><x:r><x:t>Ana </x:t></x:r><x:r><x:rPr><x:b/></x:rPr><x:t>&amp; co</x:t></x:r><x:rPh><x:t>ignored</x:t></x:rPh></x:si><x:si><x:t>start</x:t></x:si></x:sst>',
    'xl/styles.xml': `<x:styleSheet ${NS}><x:numFmts count="1"><x:numFmt numFmtId="164" formatCode="[$-409]h:mm AM/PM"/></x:numFmts>`
      + '<x:cellXfs count="4"><x:xf numFmtId="0"/><x:xf numFmtId="14"/><x:xf numFmtId="22"/><x:xf numFmtId="164"/></x:cellXfs></x:styleSheet>',
    'xl/worksheets/sheet1.xml': `<x:worksheet ${NS}><x:sheetData>${sheetXml}</x:sheetData></x:worksheet>`,
  });
}

test('Excel-style workbooks: shared strings, rich text, built-in date formats, gaps, errors', async () => {
  const [sheet] = await readXlsx(excelBook(
    '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c><x:c r="C1" t="s"><x:v>2</x:v></x:c><x:c r="D1" t="s"><x:v>3</x:v></x:c><x:c r="E1" t="s"><x:v>5</x:v></x:c></x:row>'
    + '<x:row r="3"><x:c r="A3"><x:v>7</x:v></x:c><x:c r="B3" s="1"><x:v>45292</x:v></x:c><x:c r="C3" s="2"><x:v>45292.75</x:v></x:c><x:c r="D3" t="s"><x:v>4</x:v></x:c><x:c r="E3" s="3"><x:v>0.375</x:v></x:c></x:row>'
    + '<x:row r="4"><x:c r="A4"><x:v>0.30000000000000004</x:v></x:c><x:c r="D4" t="e"><x:v>#N/A</x:v></x:c><x:c r="E4" t="str"><x:f>A4*2</x:f><x:v>calc&lt;1&gt;</x:v></x:c><x:c r="H4" s="0"/></x:row>',
  ));
  assert.equal(sheet.name, 'Q1 Orders');
  assert.equal(sheet.text, 'id,when,at,who,start\n7,2024-01-01,2024-01-01 18:00:00,Ana & co,09:00:00\n0.3,,,,calc<1>\n');
});

test('the 1904 date system and the row cap', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => `<x:row r="${i + 2}"><x:c r="A${i + 2}" s="1"><x:v>${43830 + i}</x:v></x:c></x:row>`).join('');
  const [sheet] = await readXlsx(excelBook(`<x:row r="1"><x:c r="A1" t="s"><x:v>1</x:v></x:c></x:row>${rows}`, { date1904: true }), { maxRows: 2 });
  assert.equal(sheet.text, 'when\n2024-01-01\n2024-01-02\n');
  assert.equal(sheet.truncated, true);
  assert.equal(sheet.total, 5);
  assert.equal(sheet.rows, 2);
});

test('files that are not .xlsx say so', async () => {
  await assert.rejects(readXlsx(new TextEncoder().encode('id,name\n1,a').buffer), /isn't an \.xlsx file/);
  await assert.rejects(readXlsx(zip({ 'hello.txt': 'hi' })), /No workbook/);
});
