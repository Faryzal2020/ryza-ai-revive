/* Screen clothing vs atlas variant. No costume ids, no player-keyword lists.

   The user must explicitly allow NSFW in Settings before the LLM can turn it
   on. The tag-line field is `undress:on` / `undress:off` (`nsfw` still
   parsed as an alias). Copying the filled prefix (or omit / keep) leaves the
   screen. Atlas files stay `{page}nsfw.png`. Policy text lives once in api.js. */
(function (global) {
  'use strict';

  var VARIANT = 'nsfw';

  /* The renderer is injected, so this core module never reaches into the render
     layer. It used to read `global.Avatar` directly — a reference shape the
     boundary guard could not see (no trailing dot), which is how a core->render
     edge sat in the tree while layering_check reported zero violations.
     Default inert, like every other port, so the module still loads alone. */
  var _sink = null;

  /* Permission is a user setting, not a model output: the toggle in Settings
     writes it, the gate below reads it back from Config. */
  function configuredEnabled() {
    try {
      return !!(global.Config && Config.section('app').nsfwEnabled === true);
    } catch (e) { return false; }
  }

  function apply(on) {
    /* Permission is a hard gate: model output cannot bypass it. */
    on = !!on && Nsfw._enabled;
    Nsfw._on = on;
    if (_sink) {
      try { _sink(on ? VARIANT : 'default'); } catch (e) { /* renderer is optional */ }
    }
  }

  var Nsfw = {
    VARIANT: VARIANT,
    _on: false,
    /* fn(variantName) — app.js wires Avatar.setAtlasVariant. */
    setSink: function (fn) { _sink = (typeof fn === 'function') ? fn : null; },
    _enabled: false,
    active: function () { return !!Nsfw._on; },
    enabled: function () { return !!Nsfw._enabled; },
    apply: apply,
    restore: function () {
      Nsfw._enabled = configuredEnabled();
      apply(false);
    },
    setEnabled: function (on) {
      Nsfw._enabled = !!on;
      try {
        if (global.Config && typeof Config.set === 'function') {
          Config.set('app.nsfwEnabled', Nsfw._enabled);
        }
      } catch (e) {}
      /* Enabling NSFW in settings only grants permission for the LLM to undress Ryza;
         she remains clothed unless the LLM explicitly undresses her via undress:on.
         Disabling NSFW forces Ryza back into her normal clothes immediately. */
      apply(false);
    },
    reset: function () { apply(false); },
    /* One fact for the system prompt. Not a rule list. */
    screenFact: function () {
      return Nsfw._on
        ? 'いまの画面：肌が見えている（服は脱いだあと）。'
        : 'いまの画面：普段の服を着ている。';
    },
    onTurn: function (reply) {
      var flag = reply && typeof reply.nsfw === 'boolean' ? reply.nsfw : null;
      if (flag === true) apply(true);
      else if (flag === false) apply(false);
    }
  };

  global.Nsfw = Nsfw;
})(typeof window !== 'undefined' ? window : globalThis);
