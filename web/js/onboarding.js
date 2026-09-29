/* Title + single scrollable onboarding + prologue subtitles/skip + tutorial.
   Implements 4-tier persona collection and story beginning scenario branching. */
(function (global) {
  'use strict';

  /* Tutorial lines. Recovered verbatim from the AOT snapshot. */
  var TUTORIAL = [
    { emotion: 'happy', attitude: 'agree', ja: 'やあ、会えたね。あたし、ライザ。これからよろしくね。' },
    { emotion: 'happy', attitude: 'agree', ja: '画面の見方を説明するね。' },
    { emotion: 'neutral', attitude: 'agree', ja: '上のほうのリンゴはあたしのスタミナ。' +
        '無くなると気絶しちゃうから、気をつけて。' +
        '安全な場所で寝ると回復するよ。' },
    { emotion: 'laughing', attitude: 'agree', ja: '手に入れたアイテムは、ここにしまわれるよ。' +
        'この世界のお金だよ——これも。' },
    { emotion: 'tease', attitude: 'question', ja: 'なんでも聞いてね。' +
        '困ったときは、まずは船を手に入れて、船で自由に旅へ出ようとあたしは思ってる！' },
    { emotion: 'happy', attitude: 'agree', ja: '迷ったら、クエストを進めてみて。' +
        '君だけの自由な発想で、クエストをクリアしていくのを、楽しみにしてるよ。' },
    { emotion: 'laughing', attitude: 'agree', ja: 'まずはあたしとお喋りでもしてリフレッシュしよっ' }
  ];

  var Onboarding = {
    _targetSlot: null,
    _selectedScenario: 'daily',
    _onDone: null,
    _audio: null,
    _proIdx: 1,
    _tutIdx: 0,
    _playTutAfterPro: false,

    isDone: function () {
      return !!(Config.section('state').onboardingDone);
    },

    showTitle: function (onStart) {
      var el = document.getElementById('overlay-title');
      var btn = document.getElementById('btn-title-start');
      document.body.classList.add('boot');
      el.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = I18n.t('title.start');
      btn.onclick = function () {
        if (window.Sound) Sound.unlock();
        if (onStart) onStart();
        else if (window.App && App.openStartMenu) App.openStartMenu();
      };
    },

    start: function (onDone, slotIndex) {
      if (window.Sound) {
        Sound.unlock();
        Sound.setRoute('title');
      }
      Onboarding._targetSlot = (slotIndex != null ? slotIndex : null);
      Onboarding._onDone = onDone;
      Onboarding._selectedScenario = 'daily';

      var elTitle = document.getElementById('overlay-title');
      if (elTitle) elTitle.classList.add('hidden');
      var elStart = document.getElementById('overlay-start-menu');
      if (elStart) elStart.classList.add('hidden');

      var elOnb = document.getElementById('overlay-onboard');
      if (elOnb) {
        elOnb.classList.remove('hidden');
        if (window.App && App.applyI18n) App.applyI18n(elOnb);
      }
      Onboarding._renderSingle();
    },

    _renderSingle: function () {
      var host = document.getElementById('onb-body');
      if (!host) return;
      host.innerHTML = '';
      var T = function (k) { return I18n.t(k); };
      var p = Config.section('profile');

      /* Group 1: Basic Identity */
      var g1 = document.createElement('div');
      g1.className = 'onb-group';
      g1.innerHTML = '<div class="onb-group-title">' + T('onb.secIdentity') + '</div>' +
        '<div class="onb-group-sub">' + T('onb.identity.sub') + '</div>';
      g1.appendChild(Onboarding._field(T('onb.name'), 'onb-name', 'text', p.name || ''));
      g1.appendChild(Onboarding._field(T('onb.birthday'), 'onb-bday', 'date', p.birthday || ''));

      var gGender = document.createElement('div');
      gGender.className = 'field';
      gGender.innerHTML = '<label>' + T('onb.gender') + '</label><div class="chips" id="onb-gender"></div>';
      ['female', 'male', 'other'].forEach(function (v) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip' + ((p.gender || 'other') === v ? ' on' : '');
        b.textContent = T('onb.gender.' + v);
        b.setAttribute('data-v', v);
        b.onclick = function () {
          gGender.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
          b.classList.add('on');
        };
        gGender.querySelector('#onb-gender').appendChild(b);
      });
      g1.appendChild(gGender);
      host.appendChild(g1);

      /* Group 2: Outward Persona (Tier 1) */
      var g2 = document.createElement('div');
      g2.className = 'onb-group';
      g2.innerHTML = '<div class="onb-group-title">' + T('onb.secOutward') + '</div>' +
        '<div class="onb-group-sub">' + T('profile.appearance.hint') + '</div>';
      g2.appendChild(Onboarding._field(T('profile.appearance'), 'onb-appearance', 'textarea', p.appearance || '', T('onb.q01.ph')));
      g2.appendChild(Onboarding._field(T('profile.personality'), 'onb-personality', 'text', p.personality || '', T('profile.personality.hint')));
      host.appendChild(g2);

      /* Group 3: Social Persona (Tier 2) */
      var g3 = document.createElement('div');
      g3.className = 'onb-group';
      g3.innerHTML = '<div class="onb-group-title">' + T('onb.secSocial') + '</div>' +
        '<div class="onb-group-sub">' + T('profile.background.hint') + '</div>';
      g3.appendChild(Onboarding._field(T('profile.background'), 'onb-background', 'textarea', p.background || '', T('profile.background.hint')));
      g3.appendChild(Onboarding._field(T('profile.hobby'), 'onb-hobby', 'text', p.hobby || '', T('profile.hobby.hint')));

      /* Activities chips */
      var gAct = document.createElement('div');
      gAct.className = 'field';
      gAct.innerHTML = '<label>' + T('onb.q04.prompt') + '</label><div class="chips" id="onb-activities"></div>';
      ['onb.q04.c1', 'onb.q04.c2', 'onb.q04.c3', 'onb.q04.c4', 'onb.q04.c5'].forEach(function (k) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = T(k);
        b.onclick = function () { b.classList.toggle('on'); };
        gAct.querySelector('#onb-activities').appendChild(b);
      });
      g3.appendChild(gAct);

      /* Alchemy chips */
      var gAlc = document.createElement('div');
      gAlc.className = 'field';
      gAlc.innerHTML = '<label>' + T('onb.q05.prompt') + '</label><div class="chips" id="onb-alchemy"></div>';
      ['onb.q05.c1', 'onb.q05.c2', 'onb.q05.c3', 'onb.q05.c4', 'onb.q05.c5', 'onb.q05.c6'].forEach(function (k) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = T(k);
        b.onclick = function () { b.classList.toggle('on'); };
        gAlc.querySelector('#onb-alchemy').appendChild(b);
      });
      g3.appendChild(gAlc);
      host.appendChild(g3);

      /* Group 4: Concealed Physical Anatomy (Tier 3) */
      var g4 = document.createElement('div');
      g4.className = 'onb-group';
      g4.innerHTML = '<div class="onb-group-title">' + T('onb.secIntimate') + '</div>' +
        '<div class="onb-group-sub">' + T('profile.intimateBody.hint') + '</div>';
      g4.appendChild(Onboarding._field(T('profile.intimateBody'), 'onb-intimate', 'textarea', p.intimateBody || '', T('profile.intimateBody.hint')));
      host.appendChild(g4);

      /* Group 5: Deep Secrets & Desires (Tier 4) */
      var g5 = document.createElement('div');
      g5.className = 'onb-group';
      g5.innerHTML = '<div class="onb-group-title">' + T('onb.secSecrets') + '</div>' +
        '<div class="onb-group-sub">' + T('profile.privateSecret.hint') + '</div>';
      g5.appendChild(Onboarding._field(T('profile.privateSecret'), 'onb-secret', 'textarea', p.privateSecret || '', T('profile.privateSecret.hint')));
      g5.appendChild(Onboarding._field(T('profile.futureGoals'), 'onb-goals', 'textarea', p.futureGoals || '', T('profile.futureGoals.hint')));
      host.appendChild(g5);

      /* Group 6: Story Beginning Scenario */
      var g6 = document.createElement('div');
      g6.className = 'onb-group';
      g6.innerHTML = '<div class="onb-group-title">' + T('onb.secScenario') + '</div>' +
        '<div class="onb-group-sub">' + T('onb.q06.sub') + '</div>';

      var scOptions = document.createElement('div');
      scOptions.className = 'scenario-options';

      var scenarios = [
        {
          id: 'daily',
          title: T('onb.q06.c1'),
          desc: I18n.tc('onb.scDesc.daily', 'Start in Ryza\'s atelier on Kurken Island. Ryza knows only your name and outward appearance. Tutorial is available.')
        },
        {
          id: 'longtime',
          title: T('onb.q06.c2'),
          desc: I18n.tc('onb.scDesc.longtime', 'Start in Ryza\'s atelier as longtime friends. Ryza already knows your background, hobbies, and demeanor. No tutorial.')
        },
        {
          id: 'isekai',
          title: T('onb.q06.c3'),
          desc: I18n.tc('onb.scDesc.isekai', 'Waking up in Pixie Forest moss. Ryza finds you as an injured stranger. Complete first encounter. No tutorial.')
        }
      ];

      scenarios.forEach(function (sc) {
        var card = document.createElement('div');
        card.className = 'scenario-card' + (Onboarding._selectedScenario === sc.id ? ' on' : '');
        card.setAttribute('data-scenario', sc.id);
        card.innerHTML = '<div class="sc-title">' + sc.title + '</div>' +
          '<div class="sc-desc">' + sc.desc + '</div>';
        card.onclick = function () {
          scOptions.querySelectorAll('.scenario-card').forEach(function (c) { c.classList.remove('on'); });
          card.classList.add('on');
          Onboarding._selectedScenario = sc.id;

          var tutCheck = document.getElementById('onb-opt-tutorial');
          if (tutCheck) {
            if (sc.id === 'daily') {
              tutCheck.checked = true;
              tutCheck.disabled = false;
            } else {
              tutCheck.checked = false;
              tutCheck.disabled = true;
            }
          }
        };
        scOptions.appendChild(card);
      });
      g6.appendChild(scOptions);

      /* Checkboxes for prologue & tutorial */
      var gOpts = document.createElement('div');
      gOpts.className = 'field';
      gOpts.style.marginTop = '12px';
      gOpts.innerHTML =
        '<label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer">' +
          '<input type="checkbox" id="onb-opt-prologue"> ' +
          '<span>' + T('onb.prologueOpt') + '</span>' +
        '</label>' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
          '<input type="checkbox" id="onb-opt-tutorial" checked> ' +
          '<span>' + T('onb.tutorialOpt') + '</span>' +
        '</label>';
      g6.appendChild(gOpts);
      host.appendChild(g6);

      /* Wire footer buttons */
      var bBack = document.getElementById('onb-back');
      if (bBack) {
        bBack.onclick = function () {
          document.getElementById('overlay-onboard').classList.add('hidden');
          if (window.App && App.openStartMenu) App.openStartMenu();
        };
      }

      var bSkip = document.getElementById('onb-skip');
      if (bSkip) {
        bSkip.onclick = function () {
          var def = (Config.DEFAULTS && Config.DEFAULTS.profile) ? Config.DEFAULTS.profile : {};
          Config.set('profile.name', def.name || '冒険者');
          Config.set('chara.callMe', def.name || '冒険者');
          Config.set('profile.birthday', def.birthday || '2000-01-01');
          Config.set('profile.gender', def.gender || 'other');
          Config.set('profile.storyStart', 'daily');
          Config.save();
          Onboarding._finishOnboarding(false, false);
        };
      }

      var bNext = document.getElementById('onb-next');
      if (bNext) {
        bNext.onclick = function () {
          Onboarding._saveAll();
          var playPro = !!(document.getElementById('onb-opt-prologue') && document.getElementById('onb-opt-prologue').checked);
          var playTut = !!(document.getElementById('onb-opt-tutorial') && document.getElementById('onb-opt-tutorial').checked);
          Onboarding._finishOnboarding(playPro, playTut);
        };
      }
    },

    _field: function (label, id, type, value, hint) {
      var d = document.createElement('div');
      d.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = label;
      d.appendChild(lab);
      if (type === 'textarea') {
        var ta = document.createElement('textarea');
        ta.id = id;
        ta.rows = 3;
        ta.value = value || '';
        if (hint) ta.placeholder = hint;
        d.appendChild(ta);
      } else {
        var inp = document.createElement('input');
        inp.type = type;
        inp.id = id;
        inp.value = value || '';
        if (hint) inp.placeholder = hint;
        d.appendChild(inp);
      }
      return d;
    },

    _saveAll: function () {
      var name = (document.getElementById('onb-name') || {}).value || '';
      var bday = (document.getElementById('onb-bday') || {}).value || '';
      var gEl = document.querySelector('#onb-gender .chip.on');
      Config.set('profile.name', name.trim());
      Config.set('profile.birthday', bday);
      Config.set('profile.gender', gEl ? gEl.getAttribute('data-v') : 'other');
      if (name.trim()) Config.set('chara.callMe', name.trim());

      var app = (document.getElementById('onb-appearance') || {}).value || '';
      var per = (document.getElementById('onb-personality') || {}).value || '';
      Config.set('profile.appearance', app.trim());
      Config.set('profile.personality', per.trim());

      var bg = (document.getElementById('onb-background') || {}).value || '';
      var hb = (document.getElementById('onb-hobby') || {}).value || '';
      Config.set('profile.background', bg.trim());
      Config.set('profile.hobby', hb.trim());

      var acts = [];
      document.querySelectorAll('#onb-activities .chip.on').forEach(function (c) { acts.push(c.textContent); });
      Config.set('profile.interest', acts.join('、'));

      var alcs = [];
      document.querySelectorAll('#onb-alchemy .chip.on').forEach(function (c) { alcs.push(c.textContent); });
      Config.set('profile.interestExtra', alcs.join('、'));

      var intim = (document.getElementById('onb-intimate') || {}).value || '';
      Config.set('profile.intimateBody', intim.trim());

      var sec = (document.getElementById('onb-secret') || {}).value || '';
      var gls = (document.getElementById('onb-goals') || {}).value || '';
      Config.set('profile.privateSecret', sec.trim());
      Config.set('profile.futureGoals', gls.trim());

      Config.set('profile.storyStart', Onboarding._selectedScenario || 'daily');
      Config.save();
    },

    _finishOnboarding: function (playPro, playTut) {
      Config.set('state.onboardingDone', true);
      Config.save();

      var targetSlot = Onboarding._targetSlot;
      if (targetSlot != null && window.App && App.saveSlot) {
        App.saveSlot(targetSlot);
      }

      document.getElementById('overlay-onboard').classList.add('hidden');
      if (playPro) {
        Onboarding._playTutAfterPro = playTut;
        Onboarding._prologue();
      } else if (playTut && Onboarding._selectedScenario === 'daily') {
        Onboarding._tutorial();
      } else {
        Onboarding._doneDirect();
      }
    },

    _prologue: function () {
      var ov = document.getElementById('overlay-prologue');
      if (ov) ov.classList.remove('hidden');
      if (window.Sound) Sound.setRoute('prologue');
      Onboarding._proIdx = 1;
      Onboarding._playPrologue();

      var btnSkip = document.getElementById('btn-pro-skip');
      if (btnSkip) btnSkip.onclick = function () { Onboarding.skipPrologue(); };

      var btnNext = document.getElementById('btn-pro-next');
      if (btnNext) btnNext.onclick = function () { Onboarding.prologueNext(); };
    },

    _playPrologue: function () {
      var n = Onboarding._proIdx;
      var label = document.getElementById('pro-step');
      var sub = document.getElementById('pro-sub');
      var hint = document.getElementById('pro-hint');
      if (label) label.textContent = n + ' / 9';
      if (sub) sub.textContent = I18n.t('onb.pro0' + n) || '';
      if (hint) hint.textContent = I18n.t('onb.prologueHint') || '';

      var src = Sound.prologue ? Sound.prologue(n) : '';
      if (window.App && App.playFile && src) {
        App.playFile(src, null, true);
        return;
      }
      if (Onboarding._audio) { try { Onboarding._audio.pause(); } catch (e) {} }
      if (src) {
        var a = new Audio(src);
        Onboarding._audio = a;
        a.volume = Number(Config.section('app').volume) || 0.9;
        if (window.Avatar && Avatar.setTalking) Avatar.setTalking(true);
        a.onended = function () { if (window.Avatar && Avatar.setTalking) Avatar.setTalking(false); };
        a.play().catch(function () { if (window.Avatar && Avatar.setTalking) Avatar.setTalking(false); });
      }
    },

    prologueNext: function () {
      if (Onboarding._audio) { try { Onboarding._audio.pause(); } catch (e) {} }
      if (window.App && App._pauseVoice) App._pauseVoice();
      else if (window.Avatar && Avatar.setTalking) Avatar.setTalking(false);

      if (Onboarding._proIdx < 9) {
        Onboarding._proIdx++;
        Onboarding._playPrologue();
      } else {
        var op = document.getElementById('overlay-prologue');
        if (op) op.classList.add('hidden');
        if (Onboarding._playTutAfterPro && Onboarding._selectedScenario === 'daily') {
          Onboarding._tutorial();
        } else {
          Onboarding._doneDirect();
        }
      }
    },

    skipPrologue: function () {
      if (Onboarding._audio) { try { Onboarding._audio.pause(); } catch (e) {} }
      if (window.App && App._pauseVoice) App._pauseVoice();
      else if (window.Avatar && Avatar.setTalking) Avatar.setTalking(false);

      var op = document.getElementById('overlay-prologue');
      if (op) op.classList.add('hidden');
      if (Onboarding._playTutAfterPro && Onboarding._selectedScenario === 'daily') {
        Onboarding._tutorial();
      } else {
        Onboarding._doneDirect();
      }
    },

    _tutorial: function () {
      var op = document.getElementById('overlay-prologue');
      if (op) op.classList.add('hidden');
      var oo = document.getElementById('overlay-onboard');
      if (oo) oo.classList.add('hidden');
      var ot = document.getElementById('overlay-title');
      if (ot) ot.classList.add('hidden');
      var os = document.getElementById('overlay-start-menu');
      if (os) os.classList.add('hidden');
      document.body.classList.remove('boot');

      if (window.App) {
        App.showView('talk');
        if (App.setPanelExpanded) App.setPanelExpanded(false);
      }
      if (window.Sound) {
        var st = Config.section('state');
        Sound.setPlace(st.stage, st.tod, World.backgroundFor(st.stage));
        Sound.setRoute('talk');
      }
      var bar = document.getElementById('input-bar');
      if (bar) bar.classList.add('spot');
      Onboarding._tutIdx = 0;
      Onboarding._showTut();
    },

    _showTut: function () {
      var line = TUTORIAL[Onboarding._tutIdx];
      if (!line) {
        Config.set('state.onboardingDone', true);
        var bar = document.getElementById('input-bar');
        if (bar) bar.classList.remove('spot');
        var skipBtn = document.getElementById('btn-tut-skip');
        if (skipBtn) skipBtn.classList.add('hidden');
        var ls = document.getElementById('log-sub');
        if (ls) ls.classList.remove('tut');
        if (window.App) {
          App._inTutorial = false;
          if (App._tutClass) App._tutClass(false);
          App.updateHud();
        }
        if (Onboarding._onDone) Onboarding._onDone();
        else if (window.App && App.enterGame) App.enterGame(true);
        return;
      }
      var text = (window.I18n && I18n.tc)
        ? I18n.tc('tut.' + (Onboarding._tutIdx + 1), line.ja) : line.ja;
      if (window.App) {
        App._inTutorial = true;
        if (App._tutClass) App._tutClass(true);
        var skipBtn = document.getElementById('btn-tut-skip');
        if (skipBtn) skipBtn.classList.remove('hidden');
        var ls = document.getElementById('log-sub');
        if (ls) {
          ls.classList.add('tut');
          var badge = (window.I18n && I18n.t('tut.badge')) || '🎓 Tutorial';
          var hint = (window.I18n && I18n.t('tut.tapHint')) || 'Tap screen to continue';
          ls.textContent = badge + ' (' + (Onboarding._tutIdx + 1) + '/' + TUTORIAL.length + ') · ' + hint;
        }
        if (App.showBubble) App.showBubble(text, 'narration');
        if (App.speakThen) App.speakThen(text, line.emotion);
      }
      if (window.Avatar && Avatar.setEmotion) Avatar.setEmotion(line.emotion, line.attitude);
      Onboarding._tutIdx++;
    },

    tutorialAdvance: function () {
      if (!Onboarding.isDone() && Onboarding._tutIdx > 0 && Onboarding._tutIdx <= TUTORIAL.length) {
        Onboarding._showTut();
        return true;
      }
      return false;
    },

    skipTutorial: function () {
      Onboarding._tutIdx = TUTORIAL.length;
      Config.set('state.onboardingDone', true);
      var bar = document.getElementById('input-bar');
      if (bar) bar.classList.remove('spot');
      var skipBtn = document.getElementById('btn-tut-skip');
      if (skipBtn) skipBtn.classList.add('hidden');
      var ls = document.getElementById('log-sub');
      if (ls) ls.classList.remove('tut');
      if (window.App) {
        App._inTutorial = false;
        if (App._tutClass) App._tutClass(false);
        App.updateHud();
        App.enterGame(true);
      }
    },

    replayTutorial: function () {
      Config.set('state.onboardingDone', false);
      Onboarding._onDone = function () {
        if (window.App) App.enterGame(true);
      };
      Onboarding._tutIdx = 0;
      Onboarding._tutorial();
    },

    _doneDirect: function () {
      var op = document.getElementById('overlay-prologue');
      if (op) op.classList.add('hidden');
      var oo = document.getElementById('overlay-onboard');
      if (oo) oo.classList.add('hidden');
      var ot = document.getElementById('overlay-title');
      if (ot) ot.classList.add('hidden');
      var os = document.getElementById('overlay-start-menu');
      if (os) os.classList.add('hidden');
      document.body.classList.remove('boot');
      if (window.App) {
        App.showView('talk');
        if (App.setPanelExpanded) App.setPanelExpanded(false);
      }
      if (Onboarding._onDone) {
        Onboarding._onDone();
      } else if (window.App && App.enterGame) {
        App.enterGame(true);
      }
    },

    totalSteps: function () {
      return TUTORIAL.length;
    }
  };

  global.Onboarding = Onboarding;
})(typeof window !== 'undefined' ? window : globalThis);
