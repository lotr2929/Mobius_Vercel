// test/secrets.test.mjs - the secret screen (backend/secrets.js). Secrets are cut out of a message before anything sees it; ordinary text,
// research numbers and ORCIDs are left alone. The fake keys below are built in pieces so this file holds no real-looking secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redactSecrets, redactDocs, redactionNotice } from '../backend/secrets.js';

const r = s => redactSecrets(s);
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('valid card numbers are removed, with or without spaces and dashes', () => {
  for (const n of ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111', '5555 5555 5555 4444', '3782 822463 10005']) {
    const out = r(`My card is ${n}, thanks`);
    assert.ok(out.text.includes('[card number removed]'), n);
    assert.ok(!out.text.replace(/\D/g, '').includes(n.replace(/\D/g, '')), n);
    assert.deepEqual(out.found, ['card number']);
  }
});

test('long numbers that are not cards are left alone', () => {
  for (const s of ['4111 1111 1111 1112', '0000-0002-1825-0097', '1729512345678', '+61 8 9266 7863', '10.1016/j.landurbplan.2003.01.001', 'Table 3: 20261021 123456 rows']) {
    assert.equal(r(s).text, s, s);
  }
});

test('passwords and PINs are removed, ordinary talk about passwords is not', () => {
  assert.equal(r('the wifi password is hunter2x').text, 'the wifi password is [password removed]');
  assert.equal(r('password: "Tr0ub4dor&3"').text, 'password: "[password removed]"');
  assert.equal(r('my PIN is 4821').text, 'my PIN is [PIN removed]');
  for (const s of ['the password is required', 'the password was wrong', 'my password manager is good', 'password islands are odd']) assert.equal(r(s).text, s, s);
});

test('identity numbers are removed only where the words say what they are', () => {
  assert.equal(r('My TFN is 123 456 782').text, 'My TFN is [tax file number removed]');
  assert.equal(r('Medicare number: 2123 45670 1').text, 'Medicare number: [Medicare number removed]');
  assert.equal(r('passport number is PA1234567').text, 'passport number is [passport number removed]');
  assert.equal(r("driver's licence number 1234567").text, "driver's licence number [licence number removed]");
  assert.equal(r('The reference is 123 456 782').text, 'The reference is 123 456 782');
});

test('bank details are removed', () => {
  const out = r('BSB 066-000 account number 1234 5678 please');
  assert.equal(out.text, 'BSB [BSB removed] account number [bank account number removed] please');
  assert.equal(r('Pay to GB82 WEST 1234 5698 7654 32 today').text, 'Pay to [IBAN removed] today');
  assert.equal(r('Pay to GB82 WEST 1234 5698 7654 33 today').text, 'Pay to GB82 WEST 1234 5698 7654 33 today'); // fails the IBAN check
});

test('API keys, tokens and private keys are removed', () => {
  const keys = [
    'AIza' + 'a'.repeat(35), 'sk-' + 'b1'.repeat(15), 'ghp_' + 'c'.repeat(36), 'AKIA' + 'D'.repeat(16), 'nvapi-' + 'e'.repeat(30), 'tvly-' + 'f'.repeat(24),
    'eyJ' + 'a'.repeat(20) + '.eyJ' + 'b'.repeat(20) + '.' + 'c'.repeat(20), 'Bearer ' + 'g'.repeat(30),
    '-----BEGIN ' + 'PRIVATE KEY-----\nMIIabc\n-----END ' + 'PRIVATE KEY-----',
  ];
  for (const k of keys) {
    const out = r(`here you go: ${k} done`);
    assert.ok(out.changed, k.slice(0, 8));
    assert.ok(!out.text.includes(k.slice(4, 24)), k.slice(0, 8));
  }
  assert.equal(r('api_key = abcdef1234567890abcd').text, 'api_key = [API key removed]');
  assert.equal(r('api_key = process.env.MOBIUS_KEY_VALUE').text, 'api_key = process.env.MOBIUS_KEY_VALUE'); // a variable name, not a key
});

test('ordinary text is untouched', () => {
  for (const s of [
    'Fee Yoon takes her morning tablets before breakfast.',
    'The Green Plot Ratio (Ong 2003) has 460 citations; the 2012 standard covers 700 hectares and 1,200,000 trees.',
    'Remember that I prefer British English.',
    'What does Daniel 9 say about the seventy weeks?',
  ]) assert.equal(r(s).text, s, s);
});

test('screening twice changes nothing more', () => {
  const once = r('card 4111 1111 1111 1111, password is hunter2x, TFN 123 456 782').text;
  assert.equal(r(once).text, once);
  assert.equal(r(once).changed, false);
});

test('attached documents are screened and the kinds reported', () => {
  const { docs, found } = redactDocs([{ filename: 'a.txt', text: 'card 4111 1111 1111 1111' }, { filename: 'b.txt', text: 'nothing here' }, null]);
  assert.equal(docs[0].text, 'card [card number removed]');
  assert.equal(docs[1].text, 'nothing here');
  assert.equal(docs[2], null);
  assert.deepEqual(found, ['card number']);
  assert.equal(redactionNotice([]), '');
  assert.match(redactionNotice(found), /card number/);
});

test('the places that take his words all use the screen', () => {
  assert.match(read('../backend/chat.js'), /redactSecrets\(query\)/);
  assert.match(read('../backend/server.js'), /redactSecrets\(query\)/);
  assert.match(read('../backend/pcm/notes.js'), /redactSecrets\(String\(content\)\)/);
});
