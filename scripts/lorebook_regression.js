/* Lorebook: keyword-triggered world knowledge. Entries enter the prompt only
   when a key is present in the cue / last reply / stage / islanders, always
   entries every turn, world-scope facts are labelled as unknown to Ryza, and
   the character budget holds. Headless. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const WEB = path.join(__dirname, '..', 'web');
let failures = 0;
const ok = (c, name) => { if (c) console.log('  PASS ' + name); else { failures++; console.log('  FAIL ' + name); } };
const store = {};
const sb = { console, JSON, Math, Object, Array, String, Number, Promise,
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } } };
sb.window = sb; sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(WEB, 'js', 'lorebook.js'), 'utf8'), sb, { filename: 'lorebook.js' });
const L = sb.Lorebook;
const book = JSON.parse(fs.readFileSync(path.join(WEB, 'assets/data/lore/lorebook.json'), 'utf8'));
ok(L.load(book) > 10, 'bundled book loads (' + L.entries().length + ' entries)');

const quiet = L.select({ cue: 'hello there', stage: 'stage_01_001_04' });
ok(quiet.every(e => e.always), 'a plain greeting triggers only the always entries');
const p1 = L.promptBlock({ cue: 'hello there', stage: 'stage_01_001_04' });
ok(/基本設定/.test(p1) && !/祭殿/.test(p1), 'the canon sheet is in every block, the ruins are not');

const ruins = L.select({ cue: 'Can you tell me about the sealed altar ruins?', stage: 'stage_01_001_04' });
ok(ruins.some(e => e.id === 'place.ruins') && ruins.some(e => e.id === 'world.ruins_truth'),
   'the ruins question pulls both her knowledge and the hidden world fact');
const p2 = L.promptBlock({ cue: 'Can you tell me about the sealed altar ruins?' });
ok(p2.indexOf('ライザは知らない') !== -1, 'world-scope facts are labelled as unknown to Ryza');

const forest = L.select({ cue: 'nice weather', stage: 'stage_01_002_02', field: 'field_01_002' });
ok(forest.some(e => e.id === 'place.pixie_forest'), 'standing in the forest triggers the forest entry without a keyword');

const phone = L.promptBlock({ cue: 'Where is my phone? I need the internet.' });
ok(/プレイヤーの元の世界/.test(phone) && /電話/.test(phone), 'player-world knowledge fires on "phone" / "internet"');

const reply = L.select({ cue: 'ok', reply: 'Tao said the altar inscription is old.' });
ok(reply.some(e => e.id === 'npc.tao') && reply.some(e => e.id === 'place.ruins'), 'the last reply also triggers entries');

/* budget: flood with keys, the selection stays bounded */
const many = L.select({ cue: 'kurken forest waterfall ruins lent tao empel bos bomb puni phone another world' });
const chars = many.filter(e => !e.always).reduce((n, e) => n + e.content.length, 0);
ok(many.filter(e => !e.always).length <= L.SELECT_LIMIT && chars <= L.CHAR_BUDGET,
   'selection respects SELECT_LIMIT and CHAR_BUDGET (' + many.length + ' entries, ' + chars + ' chars)');

/* user layer */
ok(L.add({ id: 'user.cat', keys: ['whiskers'], content: 'Whiskers is the atelier cat.', scope: 'ryza' }), 'a user entry can be added');
ok(L.select({ cue: 'where is whiskers?' }).some(e => e.id === 'user.cat'), 'user entries trigger like bundled ones');
ok(store['ryza.lorebook.v1'] && store['ryza.lorebook.v1'].indexOf('whiskers') !== -1, 'user entries persist');
ok(L.remove('user.cat') && !L.select({ cue: 'whiskers' }).some(e => e.id === 'user.cat'), 'and can be removed');

console.log(failures ? 'LOREBOOK: ' + failures + ' FAILURES' : 'LOREBOOK: OK');
process.exit(failures ? 1 : 0);
