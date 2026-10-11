import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Torn PDA adapts every smart quote in source before injecting its script closure.
// https://github.com/Manuito83/torn-pda/blob/master/lib/providers/userscripts_provider.dart
const adaptPdaSource = source => source.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
const bundle = await readFile(new URL('../dist/torn-targetlist.user.js', import.meta.url), 'utf8');

test('the installable userscript parses after actual Torn PDA quote preprocessing', () => {
  assert.doesNotThrow(() => new vm.Script(`(function () {\nconst PDA_storage = {};\n${adaptPdaSource(bundle)}\n})();`));
});

test('PDA compatibility check reproduces the smart apostrophe startup failure', () => {
  const unsafe = "const notice = 'Saved in the backend\u2019s database';";
  assert.doesNotThrow(() => new vm.Script(unsafe));
  assert.throws(() => new vm.Script(adaptPdaSource(unsafe)), SyntaxError);
  const safe = "const notice = 'Saved in the backend database';";
  assert.doesNotThrow(() => new vm.Script(adaptPdaSource(safe)));
});

test('PDA compatibility check applies double smart quotes as well as apostrophes', () => {
  assert.equal(adaptPdaSource('\u201cNWA\u201d \u2018target\u2019'), '"NWA" \'target\'');
});
