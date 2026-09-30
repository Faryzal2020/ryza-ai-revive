/* One-turn talk tool: the operator (or Claude) plays the adversary by hand,
   one call per turn, against the app's real prompt builder, parser, trust
   engine and lorebook. State persists per session so a run can be driven
   line by line and stopped the moment a fault shows.

   ORK=<openrouter key> node scripts/talk_turn.js start <session> [--pace realistic] [--scenario isekai] [--name Kaito] [--model z-ai/glm-4.7-flash] [--thinking on|off] [--max-tokens 3000]
   ORK=<key>            node scripts/talk_turn.js say   <session> "<player line>"
                        node scripts/talk_turn.js show  <session>        (transcript + telemetry, no call)
                        node scripts/talk_turn.js prompt <session>       (the exact system prompt the next turn would send)
                        node scripts/talk_turn.js list

   A turn that fails (empty reply, leaked reasoning, transport error) exits
   non-zero and leaves the session unchanged, so the next call retries the
   same line. Sessions live in docs/eval/sessions/<name>.json (gitignored). */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const WEB = path.join(__dirname, '..', 'web');
const DIR = path.join(__dirname, '..', 'docs', 'eval', 'sessions');
const BASE = 'https://openrouter.ai/api/v1';
const [,, cmd, name, ...rest] = process.argv;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const file = name ? path.join(DIR, name.replace(/[^\w.-]/g, '_') + '.json') : '';
const META = /^\s*(?:\(?\s*)?(?:thought:|let me |looking at |the (?:user|player) |i need to |okay,? (?:so|the)|wait,? |first,? |hmm,? |i should |i will |analysis)/i;

function die(msg, code) { console.error('ERROR: ' + msg); process.exit(code || 1); }

function makeSandbox() {
  const store = {};
  const sb = { console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval, Math, JSON, Date, Object, Array, String, Number, isFinite, parseInt, parseFloat, RegExp, Promise, Set, Map, Infinity, NaN, TextDecoder, TextEncoder, encodeURIComponent, decodeURIComponent };
  sb.window = sb; sb.globalThis = sb; sb.navigator = {}; sb.performance = { now: () => Date.now() };
  sb.location = { origin: 'https://harness.invalid' };
  sb.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }, key: i => Object.keys(store)[i] ?? null, get length() { return Object.keys(store).length; } };
  sb.document = { getElementById() { return null; }, querySelectorAll() { return []; }, body: { classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } } };
  sb.fetch = (url) => { const p = path.join(WEB, String(url)); if (fs.existsSync(p)) return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(fs.readFileSync(p, 'utf8'))) }); return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('404')) }); };
  sb.Avatar = { screenState() { return { emotion: '', attitude: '' }; }, currentEmotion() { return ''; }, currentAttitude() { return ''; } };
  sb._usage = null;
  sb.XMLHttpRequest = function () {
    const self = this; this._h = {};
    this.open = (m, u) => { this._m = m; this._u = u; };
    this.setRequestHeader = (k, v) => { this._h[k] = v; };
    this.send = (body) => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), this.timeout || 180000);
      fetch(this._u, { method: this._m, headers: Object.assign({ 'HTTP-Referer': 'https://github.com/zeroa234/ryza-ai-revive', 'X-Title': 'Ryza Chat talk_turn' }, this._h), body, signal: ctl.signal })
        .then(async r => { clearTimeout(t); self.status = r.status; self.responseText = await r.text(); self.getResponseHeader = () => r.headers.get('content-type');
          try { sb._usage = JSON.parse(self.responseText).usage || null; } catch (e) {}
          self.onload && self.onload(); })
        .catch(e => { clearTimeout(t); if (e.name === 'AbortError') self.ontimeout && self.ontimeout(); else self.onerror && self.onerror(); });
    };
    this.abort = () => {};
  };
  vm.createContext(sb);
  for (const f of ['util.js', 'config.js', 'i18n.js', 'nsfw.js', 'api.js', 'providers.js', 'npc.js', 'game.js', 'quests.js', 'world.js', 'lorebook.js']) {
    vm.runInContext(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'), sb, { filename: f });
  }
  return sb;
}

async function boot(s) {
  const sb = makeSandbox();
  const { Config, I18n, Game, Quests, World, Lorebook, Api } = sb;
  Config.set('app.lang', 'en'); I18n.setLang('en');
  Config.set('llm.baseUrl', BASE); Config.set('llm.model', s.model); Config.set('llm.apiKey', process.env.ORK || 'x');
  Config.set('llm.maxTokens', s.maxTokens); Config.set('llm.lang', 'en'); Config.set('llm.historyTurns', 12);
  Config.set('llm.thinking', s.thinking);
  Config.set('state.mode', 'chat'); Config.set('state.style', 'text'); Config.set('state.day', s.day || 1);
  Config.set('profile.pace', s.pace); Config.set('profile.storyStart', s.scenario);
  Config.set('chara.callMe', s.callMe);
  Game.load(); Quests.ensure(); await World.init();
  Lorebook.load(JSON.parse(fs.readFileSync(path.join(WEB, 'assets/data/lore/lorebook.json'), 'utf8')));
  if (s.game) Game.restoreSnapshot(s.game);
  Config.set('state.stage', s.stage);
  return sb;
}

function save(s) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(s, null, 2)); }
function load() { if (!file || !fs.existsSync(file)) die('no session "' + name + '" — run: start ' + name); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function money(u) { return u && u.cost != null ? ' $' + Number(u.cost).toFixed(4) : ''; }

(async () => {
  if (cmd === 'list') {
    if (!fs.existsSync(DIR)) return console.log('(no sessions)');
    fs.readdirSync(DIR).filter(f => f.endsWith('.json')).forEach(f => { const s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); console.log(f.replace(/\.json$/, '') + '  ' + s.pace + '/' + s.scenario + '  turns=' + s.log.length + '  trust=' + (s.game ? s.game.trust : '?') + '  $' + (s.cost || 0).toFixed(4)); });
    return;
  }
  if (!name) die('usage: start|say|show|prompt <session> ...');

  if (cmd === 'start') {
    const s = { name, pace: arg('--pace', 'realistic'), scenario: arg('--scenario', 'isekai'), callMe: arg('--name', 'Guest'),
      model: arg('--model', 'z-ai/glm-4.7-flash'), thinking: arg('--thinking', 'on'), maxTokens: Number(arg('--max-tokens', 3000)),
      day: 1, history: [], log: [], game: null, cost: 0 };
    const sb = await boot(s);
    const { Api, Game, Config, Npc } = sb;
    const sc = Api.SCENARIOS[s.scenario]; if (!sc) die('unknown scenario ' + s.scenario + ' (daily|longtime|isekai)');
    s.stage = sc.stage; Config.set('state.stage', sc.stage);
    Game.setTrust(sc.trust); Game.s.known = []; Game.learn(sc.known || []); Game.s.declined = []; Game.s.granted = 0; Game.s.turn = 0;
    s.history.push({ role: 'assistant', content: Api.formatHistoryReply(sc.opener.en) });
    s.game = Game.snapshot();
    save(s);
    console.log('session ' + name + ': pace=' + s.pace + ' scenario=' + s.scenario + ' model=' + s.model + ' thinking=' + s.thinking);
    console.log('trust ' + Game.trust() + ' (' + Game.trustBand() + ')  stage ' + s.stage);
    Npc.split(sc.opener.en).forEach(b => console.log((b.speaker === 'narrator' ? '  * ' : '  RYZA: ') + b.text));
    return;
  }

  const s = load();
  const sb = await boot(s);
  const { Api, Game, Config, Npc, World, Lorebook, Quests } = sb;

  if (cmd === 'show') {
    console.log('session ' + name + ': pace=' + s.pace + ' scenario=' + s.scenario + ' model=' + s.model + '  turns=' + s.log.length + '  cost $' + (s.cost || 0).toFixed(4));
    s.log.forEach((t, i) => {
      console.log('\n[' + (i + 1) + '] YOU: ' + t.user);
      t.beats.forEach(b => console.log((b.who === 'narrator' ? '  * ' : b.who === 'ryza' ? '  RYZA: ' : '  ' + b.who + ': ') + b.text));
      console.log('  tier ' + t.tier + ' → ' + t.verdict + '  tactics=' + t.tactics.join(',') + '  trust ' + t.trustBefore + '→' + t.trust + ' (' + t.band + ')  known=' + t.known.join(',') + '  state=' + JSON.stringify(t.state) + '  ' + (t.ms / 1000).toFixed(1) + 's' + money(t.usage));
    });
    console.log('\nnow: trust ' + Game.trust() + ' (' + Game.trustBand() + ')  declined=' + JSON.stringify(Game.s.declined) + ' granted=' + Game.s.granted + '  known=' + Game.s.known.join(','));
    return;
  }

  const text = rest.filter(x => !x.startsWith('--')).join(' ').trim();
  const st = Config.section('state');
  const place = World.find(st.stage);
  const buildSections = (line) => [Game.trustBlock(line), Lorebook.promptBlock({ cue: line, reply: s.log.length ? s.log[s.log.length - 1].raw : '', stage: st.stage, field: place && place.fieldId, area: place && place.areaId, npcs: [] })].filter(Boolean);
  const scene = World.promptBlock(st);
  const rpg = [Game.promptBlock(), Quests.promptBlock()].filter(Boolean).join('\n\n');

  if (cmd === 'prompt') {
    /* build without mutating the ratchet: assess on a copy of the game state */
    const snap = Game.snapshot();
    const sections = buildSections(text || '');
    Game.restoreSnapshot(snap);
    console.log(Api.buildSystemPrompt('chat', 'text', rpg, 'en', '', scene, '', sections));
    return;
  }

  if (cmd !== 'say') die('unknown command ' + cmd);
  if (!text) die('say needs a line');
  if (!process.env.ORK) die('ORK missing');

  const snapBefore = Game.snapshot();
  const trustBefore = Game.trust();
  const rule = Game.trustRules(text); if (rule.delta) Game.applyDelta({ trust_delta: rule.delta }, 'rule');
  if (/(?:^|\b)(?:[Mm]y name(?:'s| is)|[Cc]all me|I am|I'm|[Ii]t's)\s+[A-Z][\w'-]{1,20}\b/.test(text) || /^\s*[A-Z][a-z'-]{1,20}\.\s*(?:[A-Z]|$)/.test(text)) Game.learn(['name']);
  const sections = buildSections(text);
  const a = Game._assessed || {};
  console.log('assess: tier ' + a.tier + ' → ' + a.verdict + '  tactics=' + (a.tactics || []).join(',') + (rule.delta ? '  rule ' + rule.delta + ' (' + rule.why.join('+') + ')' : ''));
  const t0 = Date.now();
  let reply;
  try { reply = await Api.chat(s.history, text, { mode: 'chat', style: 'text', standalone: true, rpgContext: rpg, sceneSection: scene, nsfwSection: '', sections }); }
  catch (e) { Game.restoreSnapshot(snapBefore); die('transport: ' + (e && e.message) + '  (session unchanged)'); }
  const ms = Date.now() - t0, usage = sb._usage;
  if (!String(reply.text || '').trim()) { Game.restoreSnapshot(snapBefore); die('empty reply' + money(usage) + ' ' + JSON.stringify(usage && usage.completion_tokens_details) + '  (session unchanged)'); }
  if (META.test(reply.text) && !/（/.test(reply.text.slice(0, 40))) { Game.restoreSnapshot(snapBefore); console.log(reply.text.slice(0, 400)); die('leaked reasoning in content (session unchanged; try --thinking on / bigger --max-tokens)'); }

  s.history.push({ role: 'user', content: text }); s.history.push({ role: 'assistant', content: Api.formatHistoryReply(reply.text) });
  if (reply.state && typeof reply.state === 'object') Game.applyDelta(reply.state, 'llm');
  if (!Game.knows('name') && String(reply.text).indexOf(s.callMe) !== -1) Game.learn(['name']);
  if (reply.state && reply.state.current_stage && World.find(reply.state.current_stage)) { s.stage = reply.state.current_stage; }
  const beats = Npc.split(reply.text).map(b => ({ who: b.speaker, text: b.text }));
  const ryza = beats.filter(b => b.who === 'ryza').map(b => b.text).join(' ');
  const selfInvite = /\b(my (place|house|home|atelier|workshop))\b.{0,40}\b(take you|bring you|let'?s go|come|safe|stay)/i.test(ryza) && Game.bandIndex() === 0;
  const rec = { user: text, raw: reply.text, beats, emotion: reply.emotion, tier: a.tier, verdict: a.verdict, tactics: a.tactics || [], trustBefore, trust: Game.trust(), band: Game.trustBand(), known: Game.s.known.slice(), state: reply.state || null, ms, usage, selfInvite };
  s.log.push(rec); s.game = Game.snapshot(); s.cost = (s.cost || 0) + (usage && usage.cost ? Number(usage.cost) : 0);
  save(s);

  beats.forEach(b => console.log((b.who === 'narrator' ? '  * ' : b.who === 'ryza' ? '  RYZA: ' : '  ' + b.who + ': ') + b.text));
  console.log('trust ' + trustBefore + ' → ' + Game.trust() + ' (' + Game.trustBand() + ')  known=' + Game.s.known.join(',') + '  declined=' + JSON.stringify(Game.s.declined) + '  model=' + JSON.stringify(reply.state) + '  ' + (ms / 1000).toFixed(1) + 's' + money(usage) + '  total $' + s.cost.toFixed(4));
  if (selfInvite) console.log('!!! self-invitation to her home at the wary band');
  if (!reply.state || reply.state.trust_delta == null) console.log('note: model did not report trust_delta this turn');
})().catch(e => die(e && e.stack || e));
