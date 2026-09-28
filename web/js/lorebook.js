/* lorebook.js — keyword-triggered world knowledge (core layer).

   Why a separate module from longterm.js: long-term memory holds facts the
   model wrote about past conversations and scores them by cue; the lorebook
   holds authored facts about the Atelier world and scores them the same way.
   Nothing here is sent every turn except entries marked `always` (the canon
   sheet); everything else enters the prompt only when one of its keys shows
   up in the current user line, the last reply, the current stage or the
   islanders present — and a character budget keeps a chatty turn from
   pulling in the whole book.

   Entry shape (assets/data/lore/lorebook.json, plus a user layer in
   localStorage under ryza.lorebook.v1):
     { id, keys: [..], content, scope: 'ryza' | 'world' | 'player',
       priority: 1-5, always: bool, stages: [stage/field/area ids] }
   scope: ryza   = facts she knows and may state
          world  = true in the world, but Ryza does not know (narrator only)
          player = the player's own-world knowledge (isekai premise)

   No DOM. fetch() is used only for the bundled JSON, like world.js. */
(function (global) {
  'use strict';
  var KEY = 'ryza.lorebook.v1';
  var SELECT_LIMIT = 8;
  var CHAR_BUDGET = 1600;
  var SCOPES = { ryza: 1, world: 1, player: 1 };

  var _book = [];      /* bundled */
  var _user = [];      /* user-added, persisted */
  var _lastReply = '';

  function clean(e) {
    if (!e || typeof e !== 'object' || !e.id) return null;
    var keys = (Array.isArray(e.keys) ? e.keys : []).map(function (k) {
      return String(k || '').trim().toLowerCase();
    }).filter(Boolean);
    return {
      id: String(e.id),
      keys: keys,
      content: String(e.content || '').trim(),
      scope: SCOPES[e.scope] ? e.scope : 'ryza',
      priority: Math.max(1, Math.min(5, Number(e.priority) || 3)),
      always: !!e.always,
      stages: (Array.isArray(e.stages) ? e.stages : []).map(String)
    };
  }

  function loadUser() {
    try {
      var j = JSON.parse(localStorage.getItem(KEY) || '[]');
      _user = (Array.isArray(j) ? j : []).map(clean).filter(Boolean);
    } catch (e) { _user = []; }
  }
  function saveUser() {
    try { localStorage.setItem(KEY, JSON.stringify(_user)); } catch (e) {}
  }

  /* Score = key hits weighted by priority; stage membership counts as a hit.
     A key hits on a case-insensitive substring, so "kurken" matches
     "Kurken Island" and "クーケン" matches Japanese text. */
  function score(e, hay, stageIds) {
    var s = 0;
    e.keys.forEach(function (k) { if (k && hay.indexOf(k) !== -1) s += 2; });
    if (e.stages.length && stageIds.some(function (id) { return e.stages.indexOf(id) !== -1; })) s += 2;
    return s ? s + e.priority : 0;
  }

  var Lorebook = {
    SELECT_LIMIT: SELECT_LIMIT,
    CHAR_BUDGET: CHAR_BUDGET,

    /* Bundled book; a missing file is not an error (headless runs). */
    init: function (url) {
      loadUser();
      var u = url || 'assets/data/lore/lorebook.json';
      if (typeof fetch !== 'function') return Promise.resolve([]);
      return fetch(u).then(function (r) {
        if (!r.ok) throw new Error('lorebook ' + r.status);
        return r.json();
      }).then(function (j) {
        Lorebook.load(j);
        return _book;
      }).catch(function () { _book = _book || []; return _book; });
    },
    /* Direct load (tests / harness). */
    load: function (j) {
      var list = Array.isArray(j) ? j : (j && Array.isArray(j.entries) ? j.entries : []);
      _book = list.map(clean).filter(Boolean);
      return _book.length;
    },
    entries: function () { return _book.concat(_user); },
    add: function (e) {
      var c = clean(e);
      if (!c) return false;
      _user = _user.filter(function (x) { return x.id !== c.id; });
      _user.push(c);
      saveUser();
      return true;
    },
    remove: function (id) {
      var n = _user.length;
      _user = _user.filter(function (x) { return x.id !== id; });
      saveUser();
      return _user.length !== n;
    },
    noteReply: function (text) { _lastReply = String(text || ''); },

    /* ctx: { cue, reply, stage, field, area, npcs: [names] } */
    select: function (ctx) {
      ctx = ctx || {};
      var hay = [ctx.cue, ctx.reply != null ? ctx.reply : _lastReply, (ctx.npcs || []).join(' ')]
        .filter(Boolean).join('\n').toLowerCase();
      var stageIds = [ctx.stage, ctx.field, ctx.area].filter(Boolean).map(String);
      var all = Lorebook.entries();
      var always = all.filter(function (e) { return e.always; });
      var hit = all.filter(function (e) { return !e.always; })
        .map(function (e) { return { e: e, s: score(e, hay, stageIds) }; })
        .filter(function (x) { return x.s > 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .slice(0, SELECT_LIMIT)
        .map(function (x) { return x.e; });
      var out = always.slice(), used = 0;
      hit.forEach(function (e) {
        if (used + e.content.length > CHAR_BUDGET) return;
        used += e.content.length;
        out.push(e);
      });
      return out;
    },

    /* The prompt block. Known facts are hers; world facts are for the
       narrator and she must not state them; player facts describe the
       player's own world (she has never heard of any of it). */
    promptBlock: function (ctx) {
      var sel = Lorebook.select(ctx);
      if (!sel.length) return '';
      var by = { ryza: [], world: [], player: [] };
      sel.forEach(function (e) { by[e.scope].push('- ' + e.content); });
      var L = ['## 世界の知識（ロアブック）'];
      if (by.ryza.length) { L.push('ライザが知っていること：'); L.push.apply(L, by.ryza); }
      if (by.world.length) {
        L.push('この世界の事実（ライザは知らない。語り手の地の文にだけ使え。ライザの台詞で語らせない）：');
        L.push.apply(L, by.world);
      }
      if (by.player.length) {
        L.push('プレイヤーの元の世界の知識（ライザはこれらを一切知らない。聞けば戸惑い、聞き返す）：');
        L.push.apply(L, by.player);
      }
      return L.join('\n');
    },

    /* headless seams */
    _reset: function () { _book = []; _user = []; _lastReply = ''; }
  };

  global.Lorebook = Lorebook;
})(typeof window !== 'undefined' ? window : globalThis);
