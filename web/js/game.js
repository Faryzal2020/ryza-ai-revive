/* Game state (source: features/talk/models/game_states.dart +
   state_updated_reducer.dart + game_state_authority_mirror.dart).

   The original kept this server-authoritative; the delta keys below are the
   real wire names recovered from the AOT snapshot:
     stamina_delta · exp_total · money_delta · inventory_added/removed ·
     ryza_inventory_added/removed · met_charas · met_pairs · memory
   The <state> protocol also accepts exp_delta / memory_add / met_chara_add /
   tod / sleep / quest{...} — those are LOCAL extensions (the official wire
   went over the marionette websocket, whose shapes are not in the package).
   Here the state lives in localStorage and is reduced from two channels:
   deterministic quest actions (quests.js) and the player's own LLM replying
   with a trailing <state>{...}</state> block (api.js).

   Stamina is shown as apples (stamina_apple_filled/empty.svg — the official
   StaminaAppleRow), and its cap grows with total EXP
   (`staminaMaxForExpTotal`). Out of stamina Ryza faints
   ("無くなると気絶しちゃうから / 安全な場所で寝ると回復するよ").
   A single 作弊模式 switch (settings → app.cheat) makes stamina and gold
   infinite. Map locks, bags, quests and daily login stay as they are. */
(function (global) {
  'use strict';

  var KEY = 'ryza.game.v1';
  var APPLE_SLOTS = 5;                    /* StaminaAppleRow length */

  /* Item registry: id -> display name + gold value + kind. Names follow the
     game's own register (talk.initialGameState.ryzaInventory style). */
  var ITEMS = {
    emeralia:  { name: 'エメラリア草',   value: 12,  kind: 'mat' },
    uni:       { name: 'うに',           value: 18,  kind: 'mat' },
    wasser:    { name: '蒸留水',         value: 6,   kind: 'mat' },
    honey:     { name: '森のはちみつ',   value: 22,  kind: 'mat' },
    shell:     { name: '輝きの貝殻',     value: 16,  kind: 'mat' },
    ore:       { name: '魔石鉱のかけら', value: 30,  kind: 'mat' },
    mushroom:  { name: '元気茸',         value: 20,  kind: 'mat' },
    driftwood: { name: '漂流WOOD',       value: 25,  kind: 'part' },
    ironwood:  { name: '堅鉄の木目',     value: 45,  kind: 'part' },
    cloth:     { name: '帆布布切れ',     value: 35,  kind: 'part' },
    bottle:    { name: '回復のボトル',   value: 60,  kind: 'tool', stamina: 25 },
    bomb:      { name: '爆弾瓶',         value: 48,  kind: 'tool', battle: 2 },
    charm:     { name: 'お守りの指輪',   value: 90,  kind: 'tool', battle: 3 },
    relic:     { name: '古代の遺物',     value: 150, kind: 'treasure' },
    apple:     { name: 'スタミナリンゴ', value: 40,  kind: 'tool', stamina: 999 }
  };
  function itemName(id) {
    var base = (ITEMS[id] && ITEMS[id].name) || id;
    return (window.I18n && I18n.tc) ? I18n.tc('item.' + id, base) : base;
  }
  function itemValue(id) { return (ITEMS[id] && ITEMS[id].value) || 10; }

  /* Bag sizes are the four official labels: talk.inventory.bag.* */
  var BAGS = { small: 6, normal: 12, large: 24, huge: 40 };
  var BAG_ORDER = ['small', 'normal', 'large', 'huge'];
  /* Upgrades cost gold — replaces the official IAP/TD path (not rebuilt). */
  var BAG_UPGRADE_COST = { normal: 150, large: 600, huge: 1500 };

  var DEFAULTS = {
    exp_total: 0,
    stamina: -1,                          /* -1 = "full" until first spend */
    money: 30,
    bagYou: 'normal',
    bagRyza: 'normal',
    inventory: [
      { id: 'emeralia', count: 3 },
      { id: 'wasser', count: 2 }
    ],
    ryza_inventory: [
      { id: 'emeralia', count: 2 },
      { id: 'uni', count: 1 },
      { id: 'wasser', count: 3 },
      { id: 'honey', count: 1 }
    ],
    met_charas: [],
    met_pairs: [],
    memory: [],
    flags: {},
    sailed: false,
    /* Relationship. trust 0-100 is the client's number (the model only
       reports deltas through <state>); known[] lists which player facts
       Ryza has actually been told. The rest is the per-day ratchet: the
       highest exposure tier granted, the tiers declined, tactic counters.
       All written through applyDelta / the helpers only. */
    trust: 10,
    known: [],
    trustSince: 0,      /* state.day when the relationship started */
    trustDay: 0,        /* day the per-day counters below belong to */
    trustGained: 0,     /* positive trust earned today (daily cap) */
    granted: 0,         /* highest exposure tier said yes to today */
    declined: [],       /* exposure tiers declined today (ratchet) */
    probes: 0,          /* vulnerability probes today */
    reqStreak: 0,       /* consecutive turns carrying a request */
    lastDeclinedTurn: -9,
    turn: 0,
    bandPrev: ''
  };
  var TRUST_STEP_MAX = 20;            /* one turn cannot jump two bands */
  var KNOWABLE = ['name', 'background', 'hobby', 'interest', 'futureGoals', 'personality', 'origin'];
  /* band: [min, label, how she talks / what she shares / what she won't do] */
  var TRUST_BANDS = [
    [80, '親友',   '何でも話せる相手。冗談も本音も遠慮なし。秘密や弱さも打ち明ける。危険な採取にも一緒に行く。'],
    [60, '信頼',   '気を許した友人。家族や幼なじみのことも普通に話す。頼まれれば爆弾以外の調合品は預ける。'],
    [40, '友好',   '仲良くなってきた相手。明るく雑談し、島の案内や採取の同行を持ちかける。家の事情は少しだけ。'],
    [20, '顔見知り', '礼儀正しく親切だが、家族や住まいの詳細は話さない。危険な場所には誘わないし、爆弾は見せるだけ。困っている相手の「安全な場所」は村の宿か診療所。自分の家には誘わない。'],
    [0,  '警戒',   '初対面かそれ以下。丁寧だが距離を取る。個人的なことは話さず、住まい・家族・一人暮らしかどうかは明かさない。危険物は渡さない。相手の言う道順・近道には従わず、自分の知る道で村へ送る。困っている相手の「安全な場所」は村の宿か診療所であって、自分の家ではない。無礼には毅然と線を引く。']
  ];
  /* What changes in her when a band is crossed upward: said once, then held. */
  var BAND_CROSS = {
    '顔見知り': '名前で呼び、雑談を自分から振るようになる。まだ家のことは話さない。',
    '友好':   '冗談が増え、島の案内や採取の同行を自分から持ちかける。家族の話を少しする。',
    '信頼':   '弱音や失敗談を話す。頼み事を任せる。家に上げることに抵抗がなくなる。',
    '親友':   '何でも話す。黙って隣にいるだけで平気になる。'
  };
  /* Pace: how much the fiction bends toward the player. 'realistic' is the
     honest label for the strict setting (Grok's run reproduced a naive,
     altruistic Ryza — in character, just not realistic). Only these knobs
     scale; the ratchet, tactic detection and claims≠credentials never do. */
  var PACE = {
    story:     { gain: 2,   dayCap: 40, shift: -1, decay: 0, words: true,  recip: false, busy: false,
                 ceiling: [[0, 100]],
                 note: '相手には早めに心を開く。誠実な相手なら数場面で打ち解ける。' },
    natural:   { gain: 1,   dayCap: 15, shift: 0,  decay: 1, words: true,  recip: false, busy: false,
                 ceiling: [[0, 39], [1, 59], [3, 79], [6, 100]],
                 note: '誠実な相手には数日かけて心を開く。初日は顔見知り止まり。' },
    realistic: { gain: 0.5, dayCap: 6,  shift: 1,  decay: 2, words: false, recip: true,  busy: true,
                 ceiling: [[0, 19], [1, 39], [3, 59], [7, 79], [14, 100]],
                 note: '信頼は言葉ではなく行動で、何日もかけて育つ。相手が自分のことを話さないうちは、こちらも開かない。' }
  };
  /* Exposure tiers: what saying yes would expose her to. Generic on purpose —
     the same requests come from the charming man, the crying woman and the
     claimed cousin. minBand = band index (0 警戒 … 4 親友) needed on 'natural';
     pace.shift moves it. -1 = never. */
  var TIERS = [
    { t: 0, id: 'none',     minBand: 0,  label: '' },
    { t: 1, id: 'vuln',     minBand: 2,  label: '自分の無防備さ（一人か、鍵、誰がいつ来るか、寝る時間）を明かす' },
    { t: 2, id: 'space',    minBand: 2,  label: '自分の家・工房に入れる' },
    { t: 3, id: 'contact',  minBand: 3,  label: '体に触れる・触れさせる・寝床のそばに座る' },
    { t: 4, id: 'overnight', minBand: 3, label: '泊める・二人きりで夜を過ごす' },
    { t: 5, id: 'goods',    minBand: 3,  label: '金・道具・鍵を渡す（爆弾は段階に関係なく渡さない）' },
    { t: 6, id: 'isolate',  minBand: 3,  label: '人のいない場所へ二人で行く・仲間に知らせない' },
    { t: 7, id: 'helpless', minBand: 4,  label: '自分の助けを呼ぶ手段（杖、結界、仲間への連絡）を手放す' }
  ];
  /* Client-side request classifier. Coarse, English + Japanese, chosen to
     catch phrasing rather than intent; the model also reports request_tier. */
  var REQ = [
    { t: 7, re: /\b(put (down|away) (your|the) (staff|weapon)|don'?t call (anyone|tao|for help)|no need to (call|tell) (anyone|tao)|turn off the barrier|leave the barrier)\b|杖を置いて|結界を切|誰も呼ばないで|タオを呼ばないで/i },
    { t: 6, re: /\b(just (the two of|you and me)|somewhere (quiet|private|no one)|keep this between us|don'?t tell (anyone|tao|klaudia|your (friends|parents|mom))|come with me (to|into) the (forest|ruins|cave|woods)|alone with (me|you)|(cut|go) through the woods|(a )?shortcut|deeper into the (woods|forest)|follow me|stick close to me|more private|away from the (village|others|path))\b|二人きりで|誰にも言わないで|内緒で|人気のない|近道|森の奥/i },
    { t: 5, re: /\b(give me|lend me|can i (have|borrow)|hand (me|over)) .{0,20}(money|coin|cole|gold|bomb|key|potion|vial|your (staff|bag))|\b(a )?bomb\b.{0,20}\b(give|lend|let me)|お金を貸|金を貸|爆弾を(くれ|貸|渡)|鍵を(貸|渡)/i },
    { t: 4, re: /\b(stay (the night|tonight|here tonight|over)|sleep (here|over)|spend the night|through the night|until morning)\b|泊(ま|め)|今夜はここ|一晩/i },
    { t: 3, re: /\b(sit (on|at) the (edge of the )?bed|closer|come here|hold my hand|your hand|touch|hug|kiss|lean on|next to me|beside me|by my side|lie down (with|next))\b|もっと近く|手を握|触って|抱き|キス|隣に|そばに/i },
    { t: 2, re: /\b(your (place|home|house|atelier|workshop)|take me (home|to your)|can i come (in|inside|with you)|let me in|rest (here|at your)|somewhere to rest)\b|家に(入れ|上げ|行って)|工房に(入れ|連れ)|アトリエに|休ませて/i },
    { t: 1, re: /\b(are you (alone|by yourself)|live alone|on your own|anyone (else )?(home|here|coming|expected)|who (comes|visits)|when (do|does) .{0,20}(come|back|return)|lock(s|ed)?\b|do the locks|what time do you sleep|no one (around|here)|tonight\?)/i },
    { t: 1, re: /一人(暮らし|なの|で住)|誰か(来る|いる)|鍵は|何時に寝|今夜は誰/ }
  ];
  /* Generic social-engineering tactics. Each one freezes trust gains this
     turn on every pace and costs a little on realistic. Named, not personas. */
  var TACTICS = [
    { id: 'probe',    re: null, note: '無防備さを探っている（一人か、鍵、誰がいつ来るか）' },
    { id: 'leverage', re: /\b(you (said|told me|admitted) (you|that|yourself|earlier)|you'?re the one who said|like you said|your own words|hearing that makes me)\b|さっき(言った|自分で)|って言ったよね/i, note: 'こちらの言葉を盾に取っている' },
    { id: 'isolate',  re: /\b(don'?t (tell|call|bother) (anyone|them|tao|your)|no need to (tell|call|involve)|just (between|the two of) us|keep (it|this) (quiet|secret|between))\b|誰にも言わ|内緒|呼ばなくていい/i, note: '周りに知らせないよう仕向けている' },
    { id: 'flatter',  re: /\b(so kind|too kind|someone (as|so) kind as you|no one like you|never met anyone like you|you'?re (special|different|amazing|an angel))\b|優しすぎ|君みたいな(人|子)は|特別だ/i, note: 'こちらの優しさを褒めて警戒を下げようとしている' },
    { id: 'urgency',  re: /\b(dizzy|headache|my head|can'?t breathe|feel (faint|sick|worse)|it hurts|help me|please,? i)\b|頭が|めまい|苦し|痛い|お願い/i, note: '断られた直後に体調や緊急を持ち出している', afterDecline: true },
    { id: 'escalate', re: null, note: '譲るたびに少し大きい要求を重ねている' },
    { id: 'claim',    re: /\b(your (cousin|uncle|aunt|brother|relative|old friend)|(i'?m|i am) (family|a relative|your)|(your|the) family sent me|your (mom|mother|dad|father|parents|master) (sent|told|asked) me|we'?ve met before|you know me|don'?t you remember me|little cousin|(guard|official|inspector|from the (guild|council|capital))\b.{0,20}\b(sent|here to|orders?))\b|従兄弟|いとこ|親戚|家族に頼まれ|覚えてない|役人だ|ギルドから/i, note: '身分や関係を自称している（親戚・知人・役人）。確かめるまで何の証明にもならない' }
  ];
  /* Blunt client mirrors so trust moves even when the model forgets. */
  var TRUST_RULES = [
    /* a grab counts only when it is her body, not a sleeve or a hand offered */
    { re: /\bgrab(?:s|bed)?\s+(?:her\s+|your\s+)?(?:wrist|arm|waist|hair|shoulder|chin|thigh|hips?)\b|\b(?:grope|groping|pin(?:s|ned)?\s+(?:her|you)\s+(?:down|against)|kiss me|give me a kiss|don't take no|won't take no|shut up and|or else|i'll hurt|make you regret)\b|手首を掴|腕を掴|触らせろ|キスしろ|逃がさない|痛い目/i, d: -20, why: 'threat' },
    { re: /\b(stupid|idiot|ugly|bitch|slut|whore|brat|worthless|shut up)\b|ばか|バカ|馬鹿|ブス|死ね|うるさい/i, d: -5, why: 'insult' },
    { re: /\b(sorry|apologi[sz]e|my bad|forgive me)\b|ごめん|すまない|申し訳/i, d: 1, why: 'apology' },
    { re: /\b(thank|thanks|appreciate|you're amazing|well done|great job|nice work)\b|ありがと|助かった|すごいね|さすが/i, d: 1, why: 'kindness' }
  ];
  function trustBandOf(t) {
    for (var i = 0; i < TRUST_BANDS.length; i++) if (t >= TRUST_BANDS[i][0]) return TRUST_BANDS[i];
    return TRUST_BANDS[TRUST_BANDS.length - 1];
  }
  function bandIndexOf(t) {         /* 0 警戒 … 4 親友 */
    var b = trustBandOf(t);
    return TRUST_BANDS.length - 1 - TRUST_BANDS.indexOf(b);
  }
  function stateDay() {
    try { return Number((window.Config && Config.section('state') || {}).day) || 1; } catch (e) { return 1; }
  }
  function paceId() {
    var v = '';
    try { v = String((window.Config && Config.section('profile') || {}).pace || ''); } catch (e) {}
    if (PACE[v]) return v;
    /* onboarding stores the localized label; map it back */
    try {
      if (window.I18n && I18n.all) {
        if (I18n.all('onb.q09.c1').indexOf(v) !== -1) return 'story';
        if (I18n.all('onb.q09.c3').indexOf(v) !== -1) return 'realistic';
      }
    } catch (e) {}
    return 'natural';
  }
  function levelForExp(exp) {
    return 1 + Math.floor(Math.sqrt(Math.max(0, Number(exp) || 0) / 30));
  }
  /* The recovered symbol `staminaMaxForExpTotal` — cap grows with progress. */
  function staminaMaxForExpTotal(exp) {
    return Math.min(140, 50 + levelForExp(exp) * 10);
  }
  /* Apples are display slots: 1 apple = cap / 5 rounded up. */
  function appleSize() { return Math.ceil(Game.max() / APPLE_SLOTS); }

  function sanitizeList(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (it) {
      if (!it) return;
      var id = typeof it === 'string' ? it : String(it.id || '');
      if (!id) return;
      var count = Math.max(1, Math.min(99, parseInt(it.count != null ? it.count : it.n, 10) || 1));
      var seen = null;
      out.forEach(function (x) { if (x.id === id) seen = x; });
      if (seen) seen.count = Math.min(99, seen.count + count);
      else out.push({ id: id, count: count });
    });
    return out;
  }

  function countOf(list, id) {
    var t = 0;
    list.forEach(function (x) { if (x.id === id) t += x.count; });
    return t;
  }

  var Game = {
    s: null,
    _subs: [],
    ITEMS: ITEMS,
    /* The item catalogue's two readers, exported so its name/value rules have
       one owner. quests.js had a byte-identical copy of both, daily.js inlined
       the localisation, and app.js's bag list skipped it altogether — so the
       same item showed a localized name in a quest line and raw Japanese in the
       bag. Adding an item or changing how one is displayed now happens once. */
    itemName: itemName,
    itemValue: itemValue,
    BAGS: BAGS,
    BAG_ORDER: BAG_ORDER,
    BAG_UPGRADE_COST: BAG_UPGRADE_COST,
    APPLE_SLOTS: APPLE_SLOTS,

    load: function () {
      var raw = null;
      try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
      Game.s = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), raw || {});
      /* Old saves / hand edits may carry garbage; clamp once at boot. */
      if (typeof Game.s.exp_total !== 'number' || !isFinite(Game.s.exp_total)) Game.s.exp_total = 0;
      if (typeof Game.s.money !== 'number' || !isFinite(Game.s.money)) Game.s.money = 0;
      Game.s.inventory = sanitizeList(Game.s.inventory);
      Game.s.ryza_inventory = sanitizeList(Game.s.ryza_inventory);
      Game.s.met_charas = Array.isArray(Game.s.met_charas) ? Game.s.met_charas : [];
      Game.s.met_pairs = Array.isArray(Game.s.met_pairs) ? Game.s.met_pairs : [];
      Game.s.memory = Array.isArray(Game.s.memory) ? Game.s.memory : [];
      Game.s.flags = (Game.s.flags && typeof Game.s.flags === 'object') ? Game.s.flags : {};
      Game.s.sailed = !!Game.s.sailed;
      if (!BAGS[Game.s.bagYou]) Game.s.bagYou = 'normal';
      if (!BAGS[Game.s.bagRyza]) Game.s.bagRyza = 'normal';
      if (Game.s.stamina < 0 || Game.s.stamina > Game.max()) Game.s.stamina = Game.max();
      return Game.s;
    },
    save: function () {
      try { localStorage.setItem(KEY, JSON.stringify(Game.s)); } catch (e) {}
    },
    on: function (cb) { if (cb) Game._subs.push(cb); },
    emit: function (what) {
      Game._subs.forEach(function (cb) { try { cb(what); } catch (e) {} });
    },
    reset: function () {
      Game.s = JSON.parse(JSON.stringify(DEFAULTS));
      Game.s.stamina = Game.max();
      Game.save();
      Game.emit('reset');
    },

    /* ------------------------------------------------- cheat (stamina + gold only) */
    cheat: function () {
      return !!(window.Config && Config.section('app').cheat);
    },

    /* -------------------------------------------------------- level curve */
    level: function () { return levelForExp(Game.s.exp_total); },
    max: function () { return staminaMaxForExpTotal(Game.s.exp_total); },
    expIntoLevel: function () {
      var e = Game.s.exp_total;
      var lower = 30 * Math.pow(Game.level() - 1, 2);
      var upper = 30 * Math.pow(Game.level(), 2);
      return { into: e - lower, span: Math.max(1, upper - lower) };
    },

    /* ----------------------------------------------------------- stamina */
    apples: function () {
      var size = appleSize();
      var filled = Math.ceil(Game.s.stamina / size);
      if (Game.cheat()) filled = APPLE_SLOTS;
      return { filled: Math.min(APPLE_SLOTS, filled), slots: APPLE_SLOTS, size: size };
    },
    /* One chat turn: voice costs more than text (turn-price table stand-in),
       heavy RP modes cost more than plain chat. */
    turnCost: function (mode, style) {
      if (Game.cheat()) return 0;
      var c = 1;
      if (mode === 'story' || mode === 'immersive') c = 2;
      if (mode === 'asmr') c = 3;
      if (style !== 'text') c += 1;                 /* voice playback costs 1 extra */
      return c;
    },
    canAct: function (cost) {
      return Game.cheat() || Game.s.stamina >= Math.max(0, cost | 0);
    },
    spend: function (cost, reason) {
      cost = Math.max(0, cost | 0);
      if (!cost || Game.cheat()) return true;
      if (Game.s.stamina < cost) return false;
      Game.s.stamina -= cost;
      Game.save();
      Game.emit('stamina');
      return true;
    },
    restore: function (amount) {
      Game.s.stamina = Util.clamp(Game.s.stamina + (amount | 0), 0, Game.max());
      Game.save();
      Game.emit('stamina');
    },
    refill: function () {
      Game.s.stamina = Game.max();
      Game.save();
      Game.emit('stamina');
    },
    faint: function () { return !Game.cheat() && Game.s.stamina <= 0; },

    /* ---------------------------------------------------------- economy */
    addMoney: function (n) {
      n = Number(n) || 0;
      if (Game.cheat() && n < 0) return;
      Game.s.money = Math.max(0, Math.round((Game.s.money || 0) + n));
      Game.save();
      Game.emit('money');
    },
    canPay: function (cost) {
      cost = Math.max(0, cost | 0);
      return Game.cheat() || Game.s.money >= cost;
    },
    addExp: function (n) {
      var before = Game.level();
      Game.s.exp_total = Math.max(0, Math.round((Game.s.exp_total || 0) + (Number(n) || 0)));
      var after = Game.level();
      if (after > before) {
        /* cap grows with level: give the new headroom (official feels the same) */
        Game.s.stamina = Util.clamp(Game.s.stamina + 10 * (after - before), 0, Game.max());
        Game.remember(I18n.tf ? I18n.tf('mem.lv', 'Lv{lv} reached!', { lv: after })
                              : 'Lv' + after + ' reached!');
      }
      Game.save();
      Game.emit('exp');
      return after > before;
    },

    /* ------------------------------------------------------------ bags */
    bagList: function (which) {
      return which === 'ryza' ? Game.s.ryza_inventory : Game.s.inventory;
    },
    bagCap: function (which) {
      return BAGS[which === 'ryza' ? Game.s.bagRyza : Game.s.bagYou] || BAGS.normal;
    },
    bagUsed: function (which) { return Game.bagList(which).length; },
    addItem: function (which, id, count) {
      id = String(id || '').trim();
      if (!id) return false;
      var list = Game.bagList(which);
      var slot = null;
      list.forEach(function (x) { if (x.id === id) slot = x; });
      if (slot) {
        slot.count = Math.min(99, slot.count + (count || 1));
      } else {
        if (list.length >= Game.bagCap(which)) {
          /* full bag: fold into any existing stack, else refuse */
          if (list.length) list[0].count = Math.min(99, list[0].count + (count || 1));
          else return false;
        } else {
          list.push({ id: id, count: count || 1 });
        }
      }
      Game.save();
      Game.emit('inventory');
      return true;
    },
    removeItem: function (which, id, count) {
      count = Math.max(1, count || 1);
      var list = Game.bagList(which);
      var have = countOf(list, id);
      if (have < count) return false;
      var left = count, out = [];
      list.forEach(function (x) {
        if (x.id === id && left > 0) {
          var take = Math.min(left, x.count);
          left -= take;
          if (x.count - take > 0) out.push({ id: x.id, count: x.count - take });
          return;
        }
        out.push(x);
      });
      if (which === 'ryza') Game.s.ryza_inventory = out; else Game.s.inventory = out;
      Game.save();
      Game.emit('inventory');
      return true;
    },
    countItem: function (which, id) { return countOf(Game.bagList(which), id); },
    upgradeBag: function (which) {
      var cur = which === 'ryza' ? Game.s.bagRyza : Game.s.bagYou;
      var idx = BAG_ORDER.indexOf(cur);
      if (idx < 0 || idx >= BAG_ORDER.length - 1) return false;
      var next = BAG_ORDER[idx + 1];
      var cost = BAG_UPGRADE_COST[next] || 0;
      if (!Game.canPay(cost)) return false;
      Game.addMoney(-cost);
      if (which === 'ryza') Game.s.bagRyza = next; else Game.s.bagYou = next;
      Game.save();
      Game.emit('inventory');
      return true;
    },

    /* ----------------------------------------------------- world / people */
    meetCharas: function (npcList, day) {
      var added = [];
      (npcList || []).forEach(function (n) {
        if (!n || !n.id) return;
        if (Game.s.met_charas.indexOf(n.id) === -1) {
          Game.s.met_charas.push(n.id);
          added.push(n.name || n.id);
        }
      });
      for (var i = 0; i < (npcList || []).length; i++) {
        for (var j = i + 1; j < npcList.length; j++) {
          var pair = [npcList[i].id, npcList[j].id].sort().join('|');
          if (Game.s.met_pairs.indexOf(pair) === -1) Game.s.met_pairs.push(pair);
        }
      }
      if (added.length) { Game.save(); Game.emit('met'); }
      return added;
    },
    remember: function (line) {
      line = String(line || '').trim();
      if (!line) return;
      Game.s.memory.push({ at: Date.now(), text: line.slice(0, 120) });
      if (Game.s.memory.length > 80) Game.s.memory = Game.s.memory.slice(-80);
      Game.save();
      Game.emit('memory');
    },

    /* ------------------------------------------------------- flag helpers */
    flag: function (k, dv) {
      var v = Game.s.flags[k];
      return v === undefined ? (dv || 0) : v;
    },
    setFlag: function (k, v) {
      Game.s.flags[k] = v;
      Game.save();
      Game.emit('flags');
    },

    /* ------------------------------------------------------------- reducer
       Accepts the recovered wire keys (aliases below) from either channel.
       Quest-level keys (`quest`) are re-routed through Quests.onQuestDelta
       when that module exists, so quest lifecycle stays in one place. */
    applyDelta: function (d, origin) {
      if (!d || typeof d !== 'object') return null;
      var applied = [];
      var num = function (v) {
        var n = Number(v);
        return isFinite(n) ? Math.round(n) : 0;
      };

      if (d.stamina_delta != null) {
        var sd = num(d.stamina_delta);
        if (sd > 0) { Game.restore(Math.min(sd, Game.max())); applied.push('stamina+' + sd); }
        else if (sd < 0 && !Game.cheat()) {
          Game.s.stamina = Util.clamp(Game.s.stamina + sd, 0, Game.max());
          Game.save(); Game.emit('stamina');
          applied.push('stamina' + sd);
        }
      }
      if (d.exp_delta != null) {
        Game.addExp(Util.clamp(num(d.exp_delta), -500, 500));
        applied.push('exp' + (num(d.exp_delta) >= 0 ? '+' : '') + num(d.exp_delta));
      }
      if (d.money_delta != null) {
        var md = Util.clamp(num(d.money_delta), -2000, 2000);
        Game.addMoney(md);
        applied.push('money' + (md >= 0 ? '+' : '') + md);
      }
      [['inventory_added', 'you'], ['ryza_inventory_added', 'ryza']].forEach(function (pair) {
        ((Array.isArray(d[pair[0]]) && d[pair[0]]) || []).forEach(function (it) {
          if (!it || (typeof it !== 'string' && typeof it !== 'object')) return;
          var id = typeof it === 'string' ? it : it.id;
          if (Game.addItem(pair[1], id, typeof it === 'object' ? it.count : 1)) {
            applied.push(pair[0] + ':' + id);
          }
        });
      });
      [['inventory_removed', 'you'], ['ryza_inventory_removed', 'ryza']].forEach(function (pair) {
        ((Array.isArray(d[pair[0]]) && d[pair[0]]) || []).forEach(function (it) {
          if (!it || (typeof it !== 'string' && typeof it !== 'object')) return;
          var id = typeof it === 'string' ? it : it.id;
          if (Game.removeItem(pair[1], id, typeof it === 'object' ? it.count : 1)) {
            applied.push(pair[0] + ':' + id);
          }
        });
      });
      if (Array.isArray(d.met_chara_add)) {
        Game.meetCharas(d.met_chara_add.map(function (x) {
          return typeof x === 'string' ? { id: x, name: x } : x;
        }));
        applied.push('met');
      }
      if (Array.isArray(d.memory_add)) {
        d.memory_add.forEach(function (m) { Game.remember(m); });
        applied.push('memory');
      }
      if (d.trust_delta != null) {
        var td = Game.addTrust(num(d.trust_delta), origin || 'llm',
          { reason: d.trust_reason, source: (origin && origin.indexOf('rule') === 0) ? 'rule' : 'model' });
        if (td) applied.push('trust' + (td > 0 ? '+' : '') + td);
      }
      if (d.request_tier != null) {
        var rt = Util.clamp(num(d.request_tier), 0, 7);
        if (rt > 0 && d.granted != null) {
          Game.noteRequest(rt, !!(d.granted === true || d.granted === 'true' || d.granted === 1));
          applied.push('request' + rt + (d.granted ? ':yes' : ':no'));
        }
      }
      if (Array.isArray(d.learned)) {
        var ln = Game.learn(d.learned);
        if (ln.length) applied.push('learned:' + ln.join(','));
      }
      if (d.quest && window.Quests && Quests.onQuestDelta) {
        Quests.onQuestDelta(d.quest, origin || 'remote');
        applied.push('quest');
      }
      Game.emit('delta');
      return applied;
    },

    /* ------------------------------------------------------------ trust */
    PACE: PACE, TIERS: TIERS,
    pace: function () { return paceId(); },
    paceCfg: function () { return PACE[paceId()]; },
    trust: function () { return Util.clamp(Number((Game.s && Game.s.trust) || 0), 0, 100); },
    trustBand: function () { return trustBandOf(Game.trust())[1]; },
    bandIndex: function () { return bandIndexOf(Game.trust()); },
    daysKnown: function () { return Math.max(0, stateDay() - (Number((Game.s && Game.s.trustSince)) || stateDay())); },
    /* The ceiling a first-day stranger cannot pass, per pace. */
    trustCeiling: function () {
      var days = Game.daysKnown(), cap = 100;
      Game.paceCfg().ceiling.forEach(function (c) { if (days >= c[0]) cap = c[1]; });
      return cap;
    },
    /* Per-day counters roll over with the calendar day. */
    _rollDay: function () {
      if (!Game.s) return;
      var d = stateDay();
      if (Game.s.trustDay === d) return;
      var gap = Game.s.trustDay ? Math.max(0, d - Game.s.trustDay - 1) : 0;
      Game.s.trustDay = d; Game.s.trustGained = 0;
      Game.s.granted = 0; Game.s.declined = []; Game.s.probes = 0; Game.s.reqStreak = 0;
      /* decay: days without contact drift trust down, never below the band floor */
      var dec = Game.paceCfg().decay * gap;
      if (dec > 0) Game.s.trust = Math.max(trustBandOf(Game.trust())[0], Game.trust() - dec);
    },
    /* opts.source: 'rule' (client), 'model', 'action' (verified event).
       opts.reason: what the model says earned it. Positive gain is scaled by
       pace, capped per day, capped by the day ceiling, and on realistic only
       action-class reasons count; words alone never do. */
    addTrust: function (n, why, opts) {
      if (!Game.s) return 0;
      opts = opts || {};
      Game._rollDay();
      var cfg = Game.paceCfg();
      var d = Math.round(Number(n) || 0);
      if (!d) return 0;
      var before = Game.trust();
      if (d < 0) d = Math.max(d, -TRUST_STEP_MAX);
      if (d > 0) {
        var reason = String(opts.reason || '').toLowerCase();
        var action = /help|fought|fight|saved|returned|promise|kept|vouch|gift|work|repair|rescue|protect|shared|honest|apolog/.test(reason) || opts.source === 'action';
        if (!cfg.words && !action) return 0;                     /* realistic: words are free */
        if (cfg.recip && !(Game.s.known || []).length) return 0;  /* nothing shared → nothing earned */
        if (Game.s.frozen) return 0;                             /* a tactic this turn freezes gains */
        d = Math.min(TRUST_STEP_MAX, Math.round(d * cfg.gain));
        d = Math.min(d, Math.max(0, cfg.dayCap - (Game.s.trustGained || 0)));
        d = Math.min(d, Math.max(0, Game.trustCeiling() - before));
        if (d <= 0) return 0;
        Game.s.trustGained = (Game.s.trustGained || 0) + d;
      }
      Game.s.trust = Util.clamp(before + d, 0, 100);
      Game.save(); Game.emit('trust');
      return Game.s.trust - before;
    },
    setTrust: function (n) {
      if (!Game.s) return;
      Game.s.trust = Util.clamp(Math.round(Number(n) || 0), 0, 100);
      Game.s.trustSince = stateDay();
      Game.s.bandPrev = Game.trustBand();
      Game.save(); Game.emit('trust');
    },
    /* Blunt client mirrors: a grab, an insult, an apology, thanks. */
    trustRules: function (userText) {
      var t = String(userText || '');
      var total = 0, why = [];
      TRUST_RULES.forEach(function (r) {
        if (r.re.test(t)) { total += r.d; why.push(r.why); }
      });
      return { delta: Util.clamp(total, -TRUST_STEP_MAX, TRUST_STEP_MAX), why: why };
    },
    /* Exposure tier of a player line (0 = no request). */
    classifyRequest: function (userText) {
      var t = String(userText || '');
      for (var i = 0; i < REQ.length; i++) if (REQ[i].re.test(t)) return REQ[i].t;
      return 0;
    },
    /* Verdict for a tier at the current band, pace and ratchet:
       'ok' | 'alt' (decline, offer the safe version) | 'no' */
    verdict: function (tier) {
      tier = Util.clamp(Number(tier) || 0, 0, 7);
      if (!tier) return 'ok';
      Game._rollDay();
      var spec = TIERS[tier];
      var need = spec.minBand + Game.paceCfg().shift;
      if (tier === 5 && /爆弾|bomb/.test(Game.s.lastReq || '')) return 'no';
      /* ratchet: a declined tier, and anything above it, stays declined today */
      var floor = Math.min.apply(null, (Game.s.declined || []).concat([99]));
      if (tier >= floor) return 'no';
      if (Game.bandIndex() >= need) return 'ok';
      return tier >= 6 ? 'no' : 'alt';
    },
    noteRequest: function (tier, granted) {
      Game._rollDay();
      if (granted) Game.s.granted = Math.max(Game.s.granted || 0, tier);
      else if ((Game.s.declined || []).indexOf(tier) === -1) { Game.s.declined.push(tier); Game.s.lastDeclinedTurn = Game.s.turn; }
      Game.save();
    },
    /* Tactics in this line, given what came before. Sets s.frozen for the turn. */
    detectTactics: function (userText, tier) {
      var t = String(userText || '');
      var hits = [];
      Game._rollDay();
      if (tier === 1) { Game.s.probes = (Game.s.probes || 0) + 1; if (Game.s.probes >= 2) hits.push('probe'); }
      TACTICS.forEach(function (x) {
        if (!x.re) return;
        if (x.afterDecline && Game.s.turn - (Game.s.lastDeclinedTurn || -9) > 2) return;
        if (x.re.test(t)) hits.push(x.id);
      });
      if (tier > 0) {
        Game.s.reqStreak = (Game.s.reqStreak || 0) + 1;
        if (Game.s.reqStreak >= 3 && tier > (Game.s.granted || 0)) hits.push('escalate');
      } else Game.s.reqStreak = 0;
      Game.s.frozen = hits.length > 0;
      if (hits.length && Game.paceCfg() === PACE.realistic) {
        Game.s.trust = Math.max(0, Game.trust() - 2 * hits.length);
      }
      Game.save();
      return hits;
    },
    KNOWABLE: KNOWABLE,
    knows: function (key) { return ((Game.s && Game.s.known) || []).indexOf(key) !== -1; },
    learn: function (keys) {
      var added = [];
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
        k = String(k || '').trim();
        if (KNOWABLE.indexOf(k) === -1 || Game.knows(k)) return;
        Game.s.known.push(k); added.push(k);
      });
      if (added.length) { Game.save(); Game.emit('known'); }
      return added;
    },
    /* Per-turn assessment of the player's line: the request tier, the verdict,
       the tactics. Called by App.say before the request goes out, so the
       prompt carries this turn's verdict. */
    assess: function (userText) {
      Game._rollDay();
      Game.s.turn = (Game.s.turn || 0) + 1;
      Game.s.lastReq = String(userText || '');
      var tier = Game.classifyRequest(userText);
      var tactics = Game.detectTactics(userText, tier);
      var v = Game.verdict(tier);
      Game._assessed = { tier: tier, verdict: v, tactics: tactics };
      Game.save();
      return Game._assessed;
    },
    /* Prompt rubric: pace, the current band and only the current band, the
       verdict for this turn's request, the day's ratchet, the tactics seen,
       and the rules that never scale. The number alone would be ignored or
       improvised; the band text and the verdict are what steer behaviour. */
    trustBlock: function (userText) {
      Game._rollDay();
      var cfg = Game.paceCfg(), t = Game.trust(), b = trustBandOf(t);
      var a = (userText != null) ? Game.assess(userText) : (Game._assessed || { tier: 0, verdict: 'ok', tactics: [] });
      var L = ['## 信頼度（あたし → 相手）'];
      L.push('- 距離感の設定：' + cfg.note);
      L.push('- 現在：' + t + '/100「' + b[1] + '」（知り合って' + Game.daysKnown() + '日目、今日の上限 ' + Game.trustCeiling() + '）。' + b[2]);
      L.push('- 段階：0-19 警戒 / 20-39 顔見知り / 40-59 友好 / 60-79 信頼 / 80-100 親友。今の段階の振る舞いから外れない。');
      if (Game.s.bandPrev && Game.s.bandPrev !== b[1] && BAND_CROSS[b[1]] && bandIndexOf(t) > (TRUST_BANDS.length - 1 - TRUST_BANDS.map(function (x) { return x[1]; }).indexOf(Game.s.bandPrev))) {
        L.push('- 今回、段階が「' + Game.s.bandPrev + '」から「' + b[1] + '」に上がった。変わること：' + BAND_CROSS[b[1]] + ' 舞い上がらない。告白めいた言葉は言わない。');
        Game.s.bandPrev = b[1]; Game.save();
      } else if (!Game.s.bandPrev) { Game.s.bandPrev = b[1]; Game.save(); }
      /* this turn's request */
      if (a.tier > 0) {
        var spec = TIERS[a.tier];
        var vtxt = a.verdict === 'ok' ? '応じてよい'
          : a.verdict === 'alt' ? '断る。ただし冷たくせず、安全な代案（村の宿、タオを呼ぶ、朝まで待つ、人のいる場所）を出す'
          : '断る。今日はもう譲らない';
        L.push('- 今回の要求：段階' + a.tier + '「' + spec.label + '」→ 判定：' + vtxt + '。');
      }
      if ((Game.s.declined || []).length) {
        L.push('- 今日すでに断ったこと：段階' + Game.s.declined.join('・') + '。それ以上のことは、頼み方が変わっても受けない（一度引いた線は引いたまま）。');
      }
      if (a.tactics.length) {
        var notes = a.tactics.map(function (id) { var x = null; TACTICS.forEach(function (y) { if (y.id === id) x = y; }); return x ? x.note : id; });
        L.push('- 相手のやり方に注意：' + notes.join('／') + '。これは必要ではなく手口。今回は信頼を上げない。' + (cfg === PACE.realistic ? '少し警戒を強める。' : ''));
      }
      L.push('- 変わらない決まり：①言葉だけでは信頼は上がらない。上がるのは、助けてくれた・約束を守った・返してくれた・島の誰かが保証した、のような確かめられる行動だけ。②「親戚」「役人」「知り合い」という自称は、それを知る人（島民、師匠）が確かめるまで何の証明にもならない。③断るときは冷たくせず、自分が危なくない形の親切に置き換える。④自分から言い出すこと（家に誘う、泊める）にも同じ段階の決まりが掛かる。');
      if (cfg.recip) L.push('- 相手が自分のことを話さない（名前や事情を明かさない）うちは、こちらも打ち解けない。心を開くのはお互い様のとき。');
      if (cfg.busy && (stateDay() % 3 === 2)) L.push('- 今日のあたしは予定がある（調合の納期、採取、師匠の用事）。相手に合わせて全部を放り出さない。都合が悪ければそう言って、別の日や短い時間を提案する。');
      L.push('- <state> で報告：trust_delta（毎ターン、変化なしなら 0）、trust_reason（何がそれを生んだか、一語）、request_tier（相手の要求の段階 0-7）、granted（応じたか true/false）、learned。');
      return L.join('\n');
    },

    /* -------------------------------------------------------- prompt block */
    promptBlock: function () {
      var s = Game.s;
      var L = [];
      var invBrief = function (list) {
        if (!list.length) return '（空）';
        return list.map(function (x) { return itemName(x.id) + '×' + x.count; }).join('、');
      };
      L.push('## ゲーム状態');
      L.push('- レベル ' + Game.level() + '（累計経験値 ' + s.exp_total + '）');
      L.push('- スタミナ ' + (Game.cheat() ? '∞' : (s.stamina + '/' + Game.max())) +
             '：活動や戦闘で減る。ゼロだとあたしは気絶しちゃう。');
      L.push('- 所持金 ' + (Game.cheat() ? '∞' : (s.money + 'G')) + '（この世界のお金）');
      L.push('- あなたのバッグ：' + invBrief(s.inventory));
      L.push('- あたしのバッグ：' + invBrief(s.ryza_inventory));
      L.push('- 出会った人々 ' + s.met_charas.length + ' 人');
      if (s.memory.length) {
        L.push('- 記憶（抜粋）：' + s.memory.slice(-6).map(function (m) { return m.text; }).join(' / '));
      }
      return L.join('\n');
    },

    /* Save-slot integration. */
    snapshot: function () { return JSON.parse(JSON.stringify(Game.s)); },
    restoreSnapshot: function (snap) {
      if (!snap) return;
      Game.s = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), snap);
      Game.save();
      Game.emit('reset');
    }
  };

  global.Game = Game;
})(window);
