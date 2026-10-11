import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/export.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(`${source}\nglobalThis.Exporter = TargetListExport;`, context);
const { serialize } = context.Exporter;
const NOW = Date.parse('2026-10-12T12:00:00Z');
function target(overrides = {}) {
  return { id: 98765, name: 'Chain Target', faction: { id: 222, name: 'Target Faction' },
    estimatedStats: 500_000, estimateSource: 'FFScouter', estimateUpdatedAt: NOW / 1000 - 3600,
    reason: 'Approved reason', notes: 'Old notes', status: { state: 'Hospital', description: 'Recovering', until: NOW / 1000 + 600 },
    checkedAt: new Date(NOW - 1000).toISOString(), lastAction: NOW / 1000 - 120,
    reserved: true, reservationExpiresAt: new Date(NOW + 60_000).toISOString(), ...overrides };
}

function csvRows(value) {
  assert.equal(value[0], '\ufeff', 'Excel can identify UTF-8 names');
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 1; i < value.length; i++) {
    const char = value[i];
    if (char === '"') {
      if (quoted && value[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && char === ',') { row.push(cell); cell = ''; }
    else if (!quoted && char === '\r' && value[i + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; i++;
    } else cell += char;
  }
  assert.equal(quoted, false, 'all quoted fields terminate');
  assert.deepEqual(row, []);
  assert.equal(cell, '');
  return rows;
}

test('CSV exports all public target fields and the current attack URL', () => {
  const result = serialize('csv', [target()], { now: NOW });
  assert.equal(result.mime, 'text/csv;charset=utf-8');
  assert.equal(result.extension, 'csv');
  const [headers, row] = csvRows(result.text);
  assert.equal(headers.length, 17);
  assert.deepEqual(row, ['98765', 'Chain Target', '222', 'Target Faction', '500000', 'FFScouter',
    '2026-10-12T11:00:00.000Z', 'Approved reason', 'Hospital', 'Recovering', '2026-10-12T12:10:00.000Z',
    '2026-10-12T11:59:59.000Z', '2026-10-12T11:58:00.000Z', 'true', '2026-10-12T12:01:00.000Z',
    'https://www.torn.com/profiles.php?XID=98765', 'https://www.torn.com/page.php?sid=attack&user2ID=98765']);
  assert.doesNotMatch(result.text, /loader\.php/);
});

test('CSV round trips Unicode, commas, double quotes and embedded line breaks', () => {
  const name = 'Øyvind, "Sneip"';
  const reason = 'One, two\r\n三\n"quoted"';
  const result = serialize('csv', [target({ name, reason })]);
  const [, row] = csvRows(result.text);
  assert.equal(row[1], name);
  assert.equal(row[7], reason);
  assert.ok(result.text.endsWith('\r\n'));
  assert.ok(result.text.includes('"Øyvind, ""Sneip"""'));
});

test('CSV neutralizes text formulas including whitespace and control prefixes', () => {
  for (const name of ['=1+2', '+cmd', '-SUM(A1)', '@SUM(A1)', '  =1', '\t=1', '\rplain', '\tplain', '\nplain', '\u2003@SUM(A1)', '\u200b=1']) {
    const [, row] = csvRows(serialize('csv', [target({ name })]).text);
    assert.equal(row[1], `'${name}`, JSON.stringify(name));
    assert.equal(row[4], '500000', 'numeric estimates are exported as raw totals');
  }
  const [, row] = csvRows(serialize('csv', [target({ name: "'safe", reason: 'A - normal note' })]).text);
  assert.equal(row[1], "'safe");
  assert.equal(row[7], 'A - normal note');
});

test('unknown fields are blank, zero estimates survive and the reason falls back to notes', () => {
  const [, row] = csvRows(serialize('csv', [target({ name: null, faction: null, estimatedStats: 0,
    estimateSource: null, estimateUpdatedAt: null, reason: '  ', notes: '  Backup reason  ', status: null,
    checkedAt: null, lastAction: null, reserved: false, reservationExpiresAt: null })]).text);
  assert.deepEqual(row.slice(1, 15), ['', '', '', '0', '', '', 'Backup reason', '', '', '', '', '', 'false', '']);
  const markdown = serialize('markdown', [target({ estimatedStats: 0 })], { now: NOW }).text;
  assert.match(markdown, /\| 0 \| FFScouter \|/);
});

test('invalid dates, numeric values and IDs stay blank and cannot become links', () => {
  const [, row] = csvRows(serialize('csv', [target({ id: '98765', faction: { id: -1, name: 'Unlinked' },
    estimatedStats: Infinity, estimateUpdatedAt: NaN, status: { until: 1e100 }, checkedAt: 'not a date',
    lastAction: -1, reservationExpiresAt: 12 })]).text);
  for (const column of [0, 2, 4, 6, 10, 11, 12, 14, 15, 16]) assert.equal(row[column], '', `column ${column}`);
  assert.equal(row[3], 'Unlinked');
  assert.equal(csvRows(serialize('csv', [target({ estimatedStats: -1 })]).text)[1][4], '');
});

test('zero timestamp sentinels stay blank without losing a zero stat estimate', () => {
  const value = target({ estimatedStats: 0, estimateUpdatedAt: 0, lastAction: 0,
    status: { state: 'Okay', until: 0 } });
  const [, row] = csvRows(serialize('csv', [value], { now: NOW }).text);
  assert.equal(row[4], '0');
  for (const column of [6, 10, 12]) assert.equal(row[column], '', `timestamp column ${column}`);
  const markdown = serialize('markdown', [value], { now: NOW }).text;
  assert.doesNotMatch(markdown, /1970-01-01|Until:/);
  assert.match(markdown, /\| 0 \| FFScouter \|/);
});

test('Markdown retains full details in ten columns with trusted profile, faction and attack links', () => {
  const result = serialize('markdown', [target()], { now: NOW });
  assert.equal(result.mime, 'text/markdown;charset=utf-8');
  assert.equal(result.extension, 'md');
  assert.match(result.text, /^# NWA target list\n\nExported at: 2026-10-12T12:00:00\.000Z\n\nTargets: 1\n/);
  assert.match(result.text, /\[Chain Target \\\[98765\\\]\]\(https:\/\/www\.torn\.com\/profiles\.php\?XID=98765\)/);
  assert.match(result.text, /\[Target Faction \\\[222\\\]\]\(https:\/\/www\.torn\.com\/factions\.php\?step=profile&ID=222\)/);
  assert.match(result.text, /Hospital<br>Recovering<br>Until: 2026-10-12T12:10:00\.000Z<br>Reserved by another member: true<br>Reservation expires: 2026-10-12T12:01:00\.000Z/);
  assert.match(result.text, /\[Attack\]\(https:\/\/www\.torn\.com\/page\.php\?sid=attack&user2ID=98765\)/);
  const header = result.text.split('\n').find(line => line.startsWith('| Player'));
  assert.equal(header.split('|').length - 2, 10);
});

test('Markdown escapes hostile markup, pipes and newlines without breaking the table', () => {
  const result = serialize('markdown', [target({ name: '[Click](javascript:bad) <img onerror=x> *bold*',
    faction: { id: 222, name: 'A | B' }, reason: 'A\\B | C\r\nD\n<script>x & y</script> _italic_ ~strike~' })], { now: NOW });
  assert.ok(result.text.includes('\\[Click\\]\\(javascript:bad\\) &lt;img onerror=x&gt; \\*bold\\*'));
  assert.ok(result.text.includes('A \\| B'));
  assert.ok(result.text.includes('A\\\\B \\| C<br>D<br>&lt;script&gt;x &amp; y&lt;/script&gt; \\_italic\\_ \\~strike\\~'));
  assert.doesNotMatch(result.text, /<img|<script|\]\(javascript:bad\)/);
  assert.equal(result.text.split('\n').filter(line => line.startsWith('|')).length, 3);
});

test('exports whitelist public target fields, leave input unchanged and are deterministic', () => {
  const value = target({ apiKey: 'TORN_KEY_SECRET', token: 'SESSION_SECRET', player: { apiKey: 'NESTED_SECRET' },
    faction: { id: 222, name: 'Target Faction', key: 'FACTION_SECRET' } });
  const snapshot = JSON.stringify(value);
  for (const format of ['csv', 'markdown']) {
    const first = serialize(format, [value], { now: NOW });
    assert.equal(first.text, serialize(format, [value], { now: NOW }).text);
    assert.doesNotMatch(first.text, /TORN_KEY_SECRET|SESSION_SECRET|NESTED_SECRET|FACTION_SECRET|apiKey|token/);
  }
  assert.equal(JSON.stringify(value), snapshot);
});

test('empty exports include a header and do not invent target rows', () => {
  assert.equal(csvRows(serialize('csv', [], { now: NOW }).text).length, 1);
  const markdown = serialize('markdown', [], { now: NOW }).text;
  assert.match(markdown, /Targets: 0/);
  assert.equal(markdown.split('\n').filter(line => line.startsWith('|')).length, 2);
});

test('unsupported formats and non-list inputs give a useful error', () => {
  assert.throws(() => serialize('html', []), /Choose CSV or Markdown/);
  assert.throws(() => serialize('csv', { apiKey: 'PRIVATE' }), /target list is required/);
});
