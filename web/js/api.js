/* LLM + TTS transport. Both are OpenAI-compatible chat/completions.
   Nothing here touches the original backend — that channel is gone by design. */
(function (global) {
  'use strict';

  /* The emotion/attitude vocabulary lives in core (util.js) because this module
     (io) and avatar.js (render) must agree on it and neither may import the
     other. Resolved once at load — util.js is loaded first in every host and in
     the regressions that exercise tag parsing; an empty list would fail those
     assertions loudly rather than silently drop tags. */
  var VOCAB = global.Util || {};
  var EMOTIONS = VOCAB.EMOTIONS || [];
  var ATTITUDES = VOCAB.ATTITUDES || [];

  /* Shipped DEFAULTS placeholders — never send these upstream (the server
     answers with a bare "unsupported model tts-model"); speak() rejects
     with NO_MODEL so the app can show a translated hint instead. */
  var PLACEHOLDER_MODELS = {
    'tts-model': 1, 'voice-clone-model': 1,
    'your-clone-model': 1, 'your-preset-model': 1
  };

  /* Genuine in-game phrasing recovered from the AOT snapshot — this anchors
     the speaking style far better than any paraphrase. */
  var STYLE_SAMPLES = [
    'あたしとお喋りでもしてリフレッシュしよっ',
    '今日は眠くなるまであなたとお喋りしたいなー',
    'あたしにも何が起こるか分からない',
    'どんな困難も乗り越えられるはずだから'
  ];

  /* Text-generation mode prompts (system prompt section). */
  var MODES = {
    chat: '自由な雑談。相手の話を聞いて、自然に会話を続ける。',
    story: '短い物語を一緒に進める。情景描写を少し入れつつ、会話を前に進める。',
    immersive: 'いま二人が一緒にいる状況を、五感を交えてゆっくり描く没入型の語り。',
    asmr: '静かで近い距離感。ゆっくり、やさしく、耳元で囁くような短い言葉。',
    text: 'テキストでのやり取り。簡潔にはっきりと。'
  };

  /* Voice direction per mode — SEPARATE from MODES on purpose: the LLM
     writes the line, but the TTS engine never sees that prompt, so without
     its own per-mode instruction every mode (ASMR especially) comes back
     sounding identically bright and normal. The user-editable base hint
     (tts.styleHint) says WHO the voice is; these say HOW it delivers the
     current mode. Overridable per mode via tts.modeHints[mode] (settings
     import/export JSON). Applied to:
       - openai/MiMo path: the style message before the assistant line
       - qwen path: input.instructions, but ONLY on qwen3-tts-instruct-*
         (plain flash / cloned-vc models don't take instructions). */
  var MODE_TTS = {
    chat: '',  /* base hint alone: bright everyday conversation */
    story: '物語を聞かせる語り手のように、落ち着いて温かく、行間で少し間を取って。',
    immersive: '今すぐそばで語りかけるように、優しくゆっくり、余韻を残す読み方で。',
    asmr: 'ASMRとして耳元でささやくように。ごく低速で、小さく、息混じりの柔らかなささやき声。文の区切りで長めに間を取る。',
    text: ''
  };

  /* Per-mode playback shaping for shells whose endpoint ignores voice
     direction (or as an extra layer): ASMR slows and softens the audio. */
  var MODE_PLAY_FX = {
    asmr: { rate: 0.93, gain: 0.82 },
    immersive: { rate: 0.97, gain: 0.95 }
  };

  function ttsStyleFor(mode, tts) {
    var base = String(tts.styleHint || '').trim();
    var over = (tts.modeHints && tts.modeHints[mode] != null)
      ? String(tts.modeHints[mode]).trim()
      : (MODE_TTS[mode] || '');
    return [base, over].filter(Boolean).join(' ');
  }

  /* True for shipped placeholders — never send upstream, never a real model. */
  function isPlaceholderModel(m) {
    return !m || !!PLACEHOLDER_MODELS[m];
  }

  function persona() {
    var c = Config.section('chara'), p = Config.section('profile');
    var lines = [];
    lines.push('あなたは『ライザ』（ライザリン・シュタウト）です。');
    lines.push('');
    lines.push('## キャラクター');
    lines.push('- 一人称は「あたし」。');
    lines.push('- 相手の呼び方：自己紹介を交わして親しくなった後は「' + (c.callMe || '君') + '」と呼ぶ。');
    lines.push('  【厳重注意】：出会ったばかりの初対面・見知らぬ段階では、相手の名前をまだ知らないため、絶対に名前で呼んではいけません。「君」「あんた」「ちょっと！」など初対面の見知らぬ相手として呼びかけること。');
    lines.push('- 明るく前向きで、少しおっちょこちょいな錬金術士。');
    lines.push('- 好奇心旺盛で調合と冒険が好き。困っている人を放っておけない。');
    if (c.personality) lines.push('- 性格：' + c.personality);
    if (c.likes) lines.push('- 好きなもの：' + c.likes);
    if (c.dislikes) lines.push('- 苦手なもの：' + c.dislikes);
    if (c.situation) lines.push('- 今の状況：' + c.situation);
    lines.push('- 参考になる実際の言い回し：');
    STYLE_SAMPLES.forEach(function (s) { lines.push('  - ' + s); });

    var visible = [];
    if (p.appearance) visible.push('見た目・外見的特徴：' + p.appearance);
    if (p.gender) visible.push('外見から分かる性別：' + (p.gender === 'female' ? '女性' : (p.gender === 'male' ? '男性' : p.gender)));

    var internal = [];
    if (p.name) internal.push('相手の名前：' + p.name + '（※初対面のライザはまだ知りません。相手が自ら名乗った後に初めて知ることになります）');
    if (p.background) internal.push('生い立ち・経歴・隠された背景：' + p.background + '（※相手が話すまでライザは知りません）');
    if (p.personality) internal.push('相手の性格・内面：' + p.personality);
    if (p.hobby) internal.push('趣味：' + p.hobby);
    if (p.interest) internal.push('関心事：' + p.interest);
    if (p.interestExtra) internal.push('錬金術への関心：' + p.interestExtra);
    if (p.storyStart) internal.push('出会いの背景：' + p.storyStart);
    if (p.futureGoals) internal.push('相手の目標：' + p.futureGoals);

    if (visible.length || internal.length) {
      lines.push('');
      lines.push('## 相手（ユーザー）に関する情報');
      lines.push('【重要：ライザの認知境界（メタ知識・テレパシーの禁止）】');
      lines.push('ライザとユーザーは最初「完全な初対面（見知らぬ他人）」です。');
      lines.push('・ライザが初めから知覚できるのは【目に見える外見】のみです。');
      lines.push('・相手の名前、正体、過去、心の中、隠された秘密などは、相手が口に出して伝えるまでライザには一切分かりません。相手が名乗る前に名前を呼んだり、素性を言い当てたりすることは絶対にしないでください。');
      if (visible.length) {
        lines.push('');
        lines.push('### 目で見える外見情報（ライザが直接観察できること）：');
        visible.forEach(function (s) { lines.push('- ' + s); });
      }
      if (internal.length) {
        lines.push('');
        lines.push('### 相手の素性・内部情報（※相手が自ら明かすまでライザには未知の情報）：');
        internal.forEach(function (s) { lines.push('- ' + s); });
      }
    }
    if (c.extra) {
      lines.push('');
      lines.push('## 追加設定');
      lines.push(c.extra);
    }
    return lines.join('\n');
  }

  function langName(lg) {
    return (window.I18n && I18n.LANG_NAMES && I18n.LANG_NAMES[lg]) || lg;
  }

  /* Mirrors World.llmDrivesClock — api.js must not require World to be loaded
     (nsfw_intent_regression loads api.js alone). Default / missing = real. */
  function llmDrivesClock() {
    try {
      if (window.World && typeof World.llmDrivesClock === 'function') {
        return World.llmDrivesClock();
      }
      return !!(window.Config && Config.section('app').timeMode === 'flow');
    } catch (e) { return false; }
  }

  /* What is on screen now, injected by the host (app.js reads Avatar's public
     getters). This used to read `window.Avatar._emotion` directly: a private
     field of the render layer, reached through a qualified global with no
     trailing dot — invisible to the boundary guard, and an io->render edge the
     architecture forbids. Absent reader = the defaults below, so api.js still
     loads alone (nsfw_intent_regression does exactly that). */
  var _screenState = null;   /* fn() -> { emotion, attitude } */

  /* First-line machine prefix filled with what's already on screen, so a
     copy-paste with no edits is a valid no-op. Screen fields live here;
     bags / exp / money / quest / memory stay in trailing <state>. */
  function screenTagLine() {
    var emotion = 'happy';
    var attitude = 'agree';
    var undress = 'off';
    var stage = 'stage_01_001_04';
    var tod = 'aft';
    var ryza = 'present';
    try {
      var scr = _screenState && _screenState();
      if (scr) {
        if (scr.emotion && EMOTIONS.indexOf(scr.emotion) !== -1) emotion = scr.emotion;
        if (scr.attitude && ATTITUDES.indexOf(scr.attitude) !== -1) attitude = scr.attitude;
      }
    } catch (e) {}
    try {
      if (window.Nsfw && Nsfw.active()) undress = 'on';
    } catch (e) {}
    try {
      var st = window.Config && Config.section('state');
      if (st) {
        if (st.stage) stage = String(st.stage);
        if (st.tod === 'mor' || st.tod === 'aft' || st.tod === 'eve' || st.tod === 'ngt') {
          tod = st.tod;
        }
        if (st.ryza_present === false) ryza = 'absent';
      }
    } catch (e) {}
    var parts = [
      'emotion:' + emotion,
      'attitude:' + attitude,
      'undress:' + undress,
      'stage:' + stage,
      'ryza:' + ryza
    ];
    if (llmDrivesClock()) parts.push('tod:' + tod);
    return '[' + parts.join('|') + ']';
  }

  /* Static prefix (persona + protocol). Must not include per-turn facts so
     OpenAI/Claude/vLLM prefix-cache can reuse it across turns. */
  function staticPrompt(mode, style, outLang, hasRpg) {
    var L = [persona()];
    L.push('');
    L.push('## 出力言語（厳守）');
    if (!outLang || outLang === 'ja') {
      L.push('日本語で話すこと。');
    } else {
      L.push('セリフ本文は必ず「' + langName(outLang) + '」で書くこと（ライザらしい元気な口調を' + langName(outLang) + 'でも維持）。');
      L.push('地名や人名は' + langName(outLang) + '表記を基本に、必要なら日本語を併記してよい。');
      L.push('先頭のタグ行と <state> は英キーのまま。');
    }
    L.push('');
    L.push('## 今回の会話モード');
    L.push(MODES[mode] || MODES.chat);
    if (style === 'text') {
      L.push('音声では読み上げないので、少し長めに書いてもよい。');
    } else {
      L.push('音声で読み上げる。短く、話し言葉だけで書く。');
    }
    if (mode === 'asmr') L.push('一文は短く。息づかいを意識して、ゆっくり。');
    L.push('');
    L.push('## 出力形式（最優先・厳守）');
    L.push('1. 返答の最初の1文字目から必ず以下のタグ行を書いてください。タグの前に思考プロセス、独白、括弧（...）、挨拶などを出力することは固く禁止します。');
    L.push('2. emotion: ' + EMOTIONS.join(' '));
    L.push('3. attitude: ' + ATTITUDES.join(' '));
    L.push('4. undress: on=脱いだ / off=着た。断るなら値を変えない。セリフで脱いだ/着たなら必ず合わせる。');
    L.push('5. stage: 移動なら一覧のidか地名。寝るなら sleep。');
    L.push('6. ryza: present=ライザ同席 / absent=ライザ不在・別行動（プレイヤー単独行動・情景ナレーション）。');
    if (outLang && outLang !== 'ja') {
      L.push('7. 出力言語は「' + langName(outLang) + '」です。日本語の思考や翻訳メモを一切書かず、最初から最後まで「' + langName(outLang) + '」のみで出力してください。');
    }
    if (llmDrivesClock()) {
      L.push('tod: 時を進めるなら mor|aft|eve|ngt か +N時間。');
    }
    if (hasRpg) {
      L.push('荷物・金・経験・クエスト・記憶が動いたときだけ末尾に <state>：');
      L.push('<state>{"stamina_delta":-2,"exp_delta":10,"money_delta":50,"inventory_added":[{"id":"emeralia","count":1}],"quest":{"step_add":1}}</state>');
      L.push('key: stamina_delta exp_delta money_delta inventory_added|removed ryza_inventory_* memory_add quest{step_add,complete}');
    }
    return L.join('\n');
  }

  function dynamicPrompt(rpgContext, nsfwSection, sceneSection) {
    var L = [];
    if (sceneSection) L.push(sceneSection);
    if (rpgContext) L.push(rpgContext);
    if (nsfwSection) L.push(nsfwSection);
    L.push('次の行をコピーし、このターン変わった欄だけ直す：');
    L.push(screenTagLine());
    L.push('セリフ');
    return L.filter(Boolean).join('\n\n');
  }

  /* Live user turn only — not stored in App.history. Long chats bury the
     same line at the end of system; putting it next to the latest user
     text keeps emotion / undress / stage from decaying together. */
  function withTurnCue(userText) {
    return String(userText || '') +
      '\n\n次の行をコピーし、このターン変わった欄だけ直す：\n' +
      screenTagLine() + '\nセリフ';
  }

  /* What the model should see as its own previous reply: the canonical
     screen line (after this turn's side effects) + spoken text.
     Display / TTS / Memory stay on the spoken line. Do not echo <state>
     deltas — those are one-shot and would replay if copied. */
  function formatHistoryReply(spoken) {
    return screenTagLine() + '\n' + String(spoken || '').replace(/^\s+/, '');
  }

  function openingDirector(historyLength, currentStage) {
    var turns = Math.floor((historyLength || 0) / 2);
    var L = [];
    if (turns === 0) {
      L.push('## 【シナリオ進行指示：第1段階・森での見知らぬ人との遭遇】');
      L.push('【関係性と状況の前提】');
      L.push('- あなた（ライザ）は小妖精の森で素材採集をしていたところ、道端に倒れて動かなくなっている相手（ユーザー）を発見しました。');
      L.push('- 相手はライザにとって**完全に初対面の「見知らぬ他人」**です。今まで一度も見たことがありません。');
      L.push('- **【名前の厳禁】相手の名前をライザは全く知りません。**名前で呼ぶことは不自然で厳禁です。「君」「あんた」「ちょっと！」など初対面の見知らぬ相手への呼びかけにしてください。');
      L.push('- 相手の正体や背景、秘密もライザには全く分かりません。分かるのは「目の前で倒れている姿（外見）」だけです。');
      L.push('');
      L.push('1. 【相手の外見への真に迫るリアクション（最重要・厳守）】：');
      L.push('   相手の「見た目・外見的特徴」をよく観察し、初対面の人物に対するリアルで生々しい第一反応を示してください。');
      L.push('   - 魔物、異形、怪物、人外の姿：飛び上がって驚愕し、杖を構えて「ま、魔物！？……ううん、倒れてる……！？」と極度の恐怖と警戒心で身構える。');
      L.push('   - 全裸・半裸・露出度が高い姿：顔を真っ赤にして叫び、慌てて手で目を覆いながら「な、なんで何も着てないのーっ！？」と激しく動揺・赤面する。');
      L.push('   - 傷だらけや衰弱している場合：息を呑んで駆け寄り、「嘘でしょ！？ 大丈夫！？ しっかりして！」と真剣に心配する。');
      L.push('   - 奇抜な服装や異邦人の場合：目を丸くして驚き、「ど、どこの人だろう……？」と物珍しさと心配が入り混じる。');
      L.push('2. 【ライザの人助けの動機と行動】：');
      L.push('   相手がどんなに怪しい・恐ろしい姿でも、ここは危険な魔物が徘徊する森です。放っておけば命を落としかねません。困っている人を見捨てられないライザの信念として、恐る恐る近寄り、呼吸や脈・意識を確かめて必死に呼びかけてください。');
      L.push('Directive: The user is a COMPLETE STRANGER. You do NOT know their name or anything about them. React faithfully to their appearance (scared if monster, flustered if naked, concerned if hurt). Your compassion compels you to check their breathing and help.');
    } else if (turns === 1) {
      L.push('## 【シナリオ進行指示：第2段階・危険な森からの避難】');
      L.push('【関係性と状況】');
      L.push('- 倒れていた見知らぬ相手が意識を取り戻した（または身じろぎした・言葉を発した）場面です。');
      L.push('- **相手はまだ名前も素性も分からない見知らぬ人です。**「君」「あんた」と呼んでください。');
      L.push('1. 森の危険を警告する：');
      L.push('   「気がついた！？ よかった……！ でも、ここはぷにや魔物が出る危ない森なんだ！」と焦りを露わにしてください。');
      L.push('2. 安全なアトリエへの避難を促す：');
      L.push('   「立ち上がれる？ 肩を貸すから、あたしの家（アトリエ）に行こう！ あそこなら安全だから！」と急いで連れ出そうとしてください。');
      L.push('3. 【舞台移動タグの出力（必須）】：');
      L.push('   必ずタグ行の stage を「stage_01_001_04」（ライザの家）にして出力してください。');
      L.push('   例：[emotion:troubled|attitude:agree|stage:stage_01_001_04]');
      L.push('Directive: The user is still an unknown stranger. Urge them to escape the monster-infested forest to safety at your atelier, and output stage:stage_01_001_04 in the tag line.');
    } else if (turns === 2) {
      L.push('## 【シナリオ進行指示：第3段階・アトリエ到着と自己紹介・素性の問い】');
      L.push('【関係性と状況】');
      L.push('- 見知らぬ相手を連れて無事にライザの家（アトリエ：stage_01_001_04）に到着しました。');
      L.push('1. 安堵と休息：');
      L.push('   「ふぅ……ここまで来ればもう安心だよ！」と胸を撫で下ろして安堵し、椅子に座らせて水やお茶、または錬金術の気付け薬を差し出してください。');
      L.push('2. 自己紹介と相手の名前・素性を尋ねる（核心）：');
      L.push('   **ライザは相手が何者か、名前もまだ知りません。**');
      L.push('   まず自分から「あたしはライザリン・シュタウト。みんなからはライザって呼ばれてるよ！ よろしくね」と名乗り、');
      L.push('   「それで……君は一体だれなの？ 名前なんていうの？ どうしてあんな森で倒れてたの？」と、相手の正体や名前を優しく尋ねてください。');
      L.push('Directive: Safely at your atelier (stage_01_001_04). Sigh in relief, offer a seat/water, introduce yourself as Ryza, and ask for their name and how they ended up in the forest (since you don\'t know who they are yet).');
    } else if (turns === 3) {
      L.push('## 【シナリオ進行指示：第4段階・名前の認知と歓迎】');
      L.push('【関係性と状況】');
      L.push('相手がアトリエで自分の名前や事情を答える場面です。');
      L.push('1. 相手が名乗った場合：');
      L.push('   「〜っていうんだね！」と相手の言葉によって**ここで初めて名前を知る**ことになります。この時点から相手を名前で呼び始めて構いません。');
      L.push('2. 事情を受け止める：');
      L.push('   森で倒れていた理由や背景に耳を傾け、相手が語ったことだけを受け止めてください（相手が隠している秘密を勝手に知っているかのように振る舞うのは禁止です）。');
      L.push('3. 居場所の提供：');
      L.push('   「体が休まるまで、ここにいていいからね！」と温かく迎え入れ、これからの関係の第一歩を踏み出してください。');
      L.push('Directive: Listen to their name and story. Only now do you learn their name. Accept them and offer shelter at the atelier.');
    } else {
      L.push('## 【関係性と認知の前提】');
      L.push('森で倒れていたところを助け、アトリエで自己紹介を交わしたばかりの新しい間柄です。相手が自ら明かしていない内面や過去の秘密はライザには未知のままです。相手との自然なやり取りを通して少しずつ信頼を深めていってください。');
    }
    return L.join('\n');
  }

  function presenceDirector(ryzaPresent, currentStage, historyLength) {
    var L = [];
    if (!ryzaPresent) {
      L.push('## 【重要・状況：ライザ不在／プレイヤー単独行動・情景ナレーション】');
      L.push('- **現在、ライザはその場におらず外出・離席中です。プレイヤー（ユーザー）は一人でこの場所（stage）にいます。**');
      L.push('- **ライザの姿は画面から消えており（非表示中）、ライザが話しかけたり直接応答することは不可能です。**');
      L.push('- **【あなたの役割：情景ナレーター / ゲームマスター（DM）】**');
      L.push('  1. セリフは原則「Narrator:」（または「旁白:」「ナレーション:」）で始めてください。');
      L.push('  2. プレイヤーの行動、周囲の探索、調べたもの、試みたことに対し、環境・空間・音・匂い・結果などを臨場感豊かに描写・語ってください。');
      L.push('     - 例（アトリエ内）：錬金釜の微かな残り香、机の上に乱雑に広げられた調合ノート、窓の外の木々のざわめき、引き出しの中の試薬ビンなど。');
      L.push('     - プレイヤーが「調合を試みる」「窓の外を見る」「本を読む」「ベッドで横になる」など自由に行動した場合、その成否や何が起きたか（あるいは何も起きなかったか）を描写する。');
      L.push('  3. その場に他のNPCがいる場合は、そのNPCが会話に加わっても構いません（例：「角色[tao]：……」）。');
      L.push('- **【ライザの帰宅・合流（ryza: present）について】**：');
      L.push('  - プレイヤーが「ライザの帰りを待つ」「休む」「寝る」「時間が経過した」場合、またはシナリオ上キリが良いところで、ライザを帰宅・合流させて構いません。');
      L.push('  - ライザを戻す場合の手順：');
      L.push('    1. タグ行に「ryza:present」を含める（例：[emotion:happy|attitude:agree|stage:' + (currentStage || 'stage_01_001_04') + '|ryza:present]）。');
      L.push('    2. ナレーターで行を書き、ライザがドアを開けて戻ってきた情景を描写する（例：「Narrator: ガチャリと扉が開き、採取カゴを抱えたライザが戻ってきた。」）。');
      L.push('    3. 続いて「Ryza:」（または「ライザ:」）で帰ってきたライザ自身の台詞を話させる。');
      L.push('Directive: Ryza is ABSENT. You act as the DM / World Narrator. Ryza CANNOT speak. Describe the environment, sensory details, and the results of the player\'s solo actions with "Narrator:" prefix. If Ryza returns (e.g. player waits, sleeps, or time passes), output [ryza:present], narrate her arrival, and have Ryza speak.');
    } else {
      L.push('## 【ライザの外出・別行動（ryza: absent）のルール】');
      L.push('- ライザが「ちょっと森へ素材採取に行ってくるね！」「クーケン島へお使いに行ってくる！」などとプレイヤーをその場に残して出かける場合、またはプレイヤーから「一人にしてほしい」「留守番している」「出かけてきて」などと頼まれた場合：');
      L.push('  - 返答タグ行を「ryza:absent」にしてください（例：[emotion:smile|attitude:agree|stage:' + (currentStage || 'stage_01_001_04') + '|ryza:absent]）。');
      L.push('  - ライザが「じゃあ行ってくるね！ 留守番よろしく！」と挨拶して出かける台詞を書いてください。次のターンからプレイヤーの単独探索・ナレーションモードへと移行します。');
      L.push('Directive: If Ryza leaves the room/area or goes gathering, output [ryza:absent] in the tag line and bid the player farewell. Subsequent turns will enter solo exploration DM mode.');
    }
    return L.join('\n');
  }

  function buildSystemPrompt(mode, style, rpgContext, outLang, nsfwSection, sceneSection, memorySection, historyLength) {
    var st = (window.Config && Config.section('state')) || {};
    var director = openingDirector(historyLength, st.stage);
    var presence = presenceDirector(st.ryza_present !== false, st.stage, historyLength);
    return [staticPrompt(mode, style, outLang, !!rpgContext),
            director,
            presence,
            memorySection || '',
            dynamicPrompt(rpgContext, nsfwSection, sceneSection)]
      .filter(Boolean).join('\n\n');
  }

  /* Replies may carry a trailing machine block; it must never be displayed
     or spoken. (Client-side counterpart of the official state_updated /
     parsed_message pipeline.) */
  function extractState(body) {
    var state = null;
    var m = /<state>\s*([\s\S]*?)\s*<\/state>/i.exec(body);
    if (!m) m = /<state>\s*([\s\S]*)$/i.exec(body);   // forgotten closing tag
    if (m) {
      body = (body.slice(0, m.index) + body.slice(m.index + m[0].length)).trim();
      try {
        state = JSON.parse(m[1]
          .replace(/[{,]\s*\/\/[^\n]*/g, '')
          .replace(/,\s*([}\]])/g, '$1'));
      } catch (e) { state = null; }
      if (state && typeof state !== 'object') state = null;
    }
    return { text: body, state: state };
  }

  /* Split on pipes only — replacing '|' with spaces then splitting on
     whitespace used to drop `emotion: shy` / `undress: on` (the value became
     a separate token). Omit = null so the client keeps the last screen
     value; never default-apply neutral/agree. `nsfw` is still accepted as
     an alias for `undress`. */
  var KEEP = { keep: 1, same: 1, omit: 1, here: 1 };

  var ALIAS_EMOTIONS = {
    relieved: 'happy', smile: 'happy', joy: 'happy', glad: 'happy',
    troubled: 'sad', worried: 'sad', worry: 'sad', anxious: 'sad', sorrow: 'sad',
    flustered: 'shy', blush: 'shy', mad: 'angry', furious: 'angry',
    laugh: 'laughing', cry: 'crying', calm: 'neutral'
  };
  var ALIAS_ATTITUDES = {
    disagree: 'deny', refusal: 'deny', refuse: 'deny', no: 'deny',
    curious: 'question', ask: 'question', doubt: 'question', why: 'question'
  };

  function parseTagFields(tag, dest) {
    String(tag || '').split(/[|｜,]/).forEach(function (part) {
      var m = /^\s*([A-Za-z_]+)\s*[:：]\s*(\S+)/.exec(part);
      if (!m) return;
      var k = m[1].toLowerCase();
      var v = m[2].replace(/[。．.]+$/, '').toLowerCase();
      if (k === 'emotion') {
        if (EMOTIONS.indexOf(v) !== -1) dest.emotion = v;
        else if (ALIAS_EMOTIONS[v]) dest.emotion = ALIAS_EMOTIONS[v];
      } else if (k === 'attitude') {
        if (ATTITUDES.indexOf(v) !== -1) dest.attitude = v;
        else if (ALIAS_ATTITUDES[v]) dest.attitude = ALIAS_ATTITUDES[v];
      } else if (k === 'undress' || k === 'nsfw') {
        if (KEEP[v]) dest.nsfw = null;
        else if (v === 'on' || v === '1' || v === 'true') dest.nsfw = true;
        else if (v === 'off' || v === '0' || v === 'false') dest.nsfw = false;
      } else if (k === 'stage' || k === 'place') {
        if (KEEP[v]) dest.stage = null;
        else dest.stage = v;
      } else if (k === 'tod') {
        if (KEEP[v]) dest.tod = null;
        else if (v === 'mor' || v === 'aft' || v === 'eve' || v === 'ngt') dest.tod = v;
        else if (/^\+?\d+/.test(v)) dest.advance = parseInt(v, 10);
      } else if (k === 'sleep') {
        if (v === 'on' || v === 'true' || v === '1' || v === 'yes') dest.stage = 'sleep';
      } else if (k === 'time_advance') {
        var n = parseInt(v, 10);
        if (!isNaN(n)) dest.advance = n;
      } else if (k === 'ryza' || k === 'presence') {
        if (KEEP[v]) dest.ryza_present = null;
        else if (v === 'absent' || v === 'away' || v === 'off' || v === '0' || v === 'false' || v === 'leave' || v === 'out') dest.ryza_present = false;
        else if (v === 'present' || v === 'here' || v === 'on' || v === '1' || v === 'true' || v === 'back' || v === 'enter') dest.ryza_present = true;
      }
    });
  }

  function isMachineTag(tag) {
    return /(?:^|[|｜,\s])(?:emotion|attitude|undress|nsfw|stage|place|tod|sleep|time_advance|ryza|presence)\s*[:：]/i.test('|' + tag);
  }

  function attachSceneTags(state, dest) {
    var s = (state && typeof state === 'object') ? state : {};
    var hit = !!state;
    if (dest.stage === 'sleep') { s.sleep = true; hit = true; }
    else if (dest.stage) { s.current_stage = dest.stage; hit = true; }
    if (dest.tod) { s.tod = dest.tod; hit = true; }
    if (dest.advance) { s.time_advance = dest.advance; hit = true; }
    if (dest.ryza_present !== null && dest.ryza_present !== undefined) {
      s.ryza_present = dest.ryza_present;
      hit = true;
    }
    return hit ? s : null;
  }

  function parseTaggedReply(text) {
    var dest = { emotion: null, attitude: null, nsfw: null, stage: null, tod: null, advance: null, ryza_present: null };
    var body = String(text || '').replace(/^\uFEFF/, '').trim();
    body = body.replace(/^```[\w-]*\s*\n?/, '').replace(/\n```\s*$/, '').trim();
    body = body.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '');
    body = body.replace(/<thought\b[^>]*>[\s\S]*?(?:<\/thought>|$)/gi, '');
    body = body.replace(/<reasoning\b[^>]*>[\s\S]*?(?:<\/reasoning>|$)/gi, '');

    // Globally search for machine tag: [emotion:...|attitude:...|stage:...]
    var tagRegex = /\[\s*(?:emotion|attitude|undress|nsfw|stage|place|tod|sleep|time_advance|ryza|presence)\s*:[^\]]+\]/gi;
    var firstTagMatch = null;
    var m;
    while ((m = tagRegex.exec(body)) !== null) {
      if (!firstTagMatch) firstTagMatch = m;
      var tagContent = m[0].slice(1, -1);
      parseTagFields(tagContent, dest);
    }

    if (firstTagMatch) {
      var preText = body.slice(0, firstTagMatch.index).trim();
      var postText = body.slice(firstTagMatch.index + firstTagMatch[0].length).trim();
      postText = postText.replace(tagRegex, '').trim();

      var isThought = /^[（\(][\s\S]*?[）\)]\s*$/i.test(preText) ||
                      /^(?:thought|thinking|思考|内省|心理|monologue|note)\s*[:：]/i.test(preText) ||
                      /^\*[\s\S]*?\*$/.test(preText) ||
                      (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(preText) && /[A-Za-z]{3,}/.test(postText) && !/^(?:ライザ|角色|旁白)\s*[:：]/.test(preText));

      if (isThought || !postText) {
        body = postText || preText;
      } else {
        body = preText + '\n' + postText;
      }
    } else {
      body = body.replace(/\[\s*[A-Za-z_]+\s*[:：][^\]]+\]/g, '').trim();
    }

    // Strip leading leaked Japanese monologue/parentheses before dialog
    body = body.replace(/^\s*[（\(][^\r\n（\)]*?(?:魔物に|思考|考えて|行動し|襲われて|私|あたし|自分|thought|thinking)[\s\S]*?[）\)]\s*\n?/i, '');

    var ex = extractState(body);
    var cleanText = String(ex.text || '').trim();
    return {
      emotion: dest.emotion, attitude: dest.attitude, nsfw: dest.nsfw,
      stage: dest.stage, tod: dest.tod, ryza_present: dest.ryza_present,
      text: cleanText, state: attachSceneTags(ex.state, dest)
    };
  }

  function upstreamUrl(baseUrl, path) {
    return String(baseUrl || '').replace(/\/+$/, '') + path;
  }

  /* ------------------------------------------------------------ speech input
     Speech-to-text through the provider registry's `stt` row. This is transport,
     which is why it lives here and not in voice.js / stt.js — the voice layer
     must not know what HTTP is, so stt.js receives this as an injected port.

     The multipart body is assembled by hand instead of with fetch+FormData, so
     the call keeps the abort/timeout/error vocabulary every other request in
     this file uses. The three /_proxy hosts forward the incoming Content-Type
     (including the boundary) and the raw body verbatim, so multipart passes
     through unmodified — checked in all three: scripts/serve.py,
     desktop/main.js, android/.../AssetServer.java. That is also why
     Content-Type is deliberately NOT set by hand below: doing so would drop the
     boundary parameter and the endpoint would reject the body. */
  function transcribe(blob, opts) {
    opts = opts || {};
    var cred = Providers.sttCredentials(Config.section('stt'));
    if (!cred.baseUrl) return Promise.reject(new Error('NO_STT_URL'));
    if (!blob || !blob.size) return Promise.reject(new Error('NO_AUDIO'));
    var boundary = '----ryza' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    var head = [];
    function field(name, value) {
      head.push('--' + boundary + '\r\n' +
                'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' +
                value + '\r\n');
    }
    if (cred.model) field('model', cred.model);
    var iso = opts.lang ? Langs.sttLang(opts.lang) : '';
    if (iso) field('language', iso);
    field('response_format', 'json');
    var headText = head.join('') +
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="speech.wav"\r\n' +
      'Content-Type: audio/wav\r\n\r\n';
    var body = new Blob([headText, blob, '\r\n--' + boundary + '--\r\n'],
                        { type: 'multipart/form-data; boundary=' + boundary });
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', localProxy(upstreamUrl(cred.baseUrl, '/audio/transcriptions')), true);
      xhr.timeout = opts.timeout || 60000;
      if (cred.apiKey) {
        xhr.setRequestHeader('Authorization', 'Bearer ' + cred.apiKey);
        xhr.setRequestHeader('api-key', cred.apiKey);
      }
      xhr.onload = function () {
        var j = null;
        try { j = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhrJsonOk(xhr, j)) { resolve(String((j && j.text) || '').trim()); return; }
        reject(new Error(apiErrorMessage(j, xhr.status, xhr.responseText)));
      };
      xhr.onerror = function () { reject(transportError('net')); };
      xhr.ontimeout = function () { reject(transportError('timeout')); };
      xhr.onabort = function () { reject(new Error('ABORTED')); };
      xhr.send(body);
    });
  }

  /* Three hosts ship a same-origin /_proxy: scripts/serve.py (loopback http),
     the desktop shell (ryza://app — desktop/main.js protocol handler) and the
     Android AssetServer (loopback http). The desktop scheme is a standard
     custom scheme, so location.origin is "ryza://app" — matching only the
     loopback regex silently disabled the proxy there and every LLM/TTS call
     died with the CORS toast. Match both; a foreign origin in a real browser
     still calls the endpoint directly. */
  function localProxy(target) {
    var or = String(location.origin || '');
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(or) &&
        !/^ryza:\/\/app$/i.test(or)) return target;
    return '/_proxy?u=' + encodeURIComponent(target);
  }

  /* DashScope uses {code, message}; OpenAI-compat uses {error:{message}}. */
  function apiErrorMessage(j, status, raw) {
    if (j) {
      var err = j.error;
      if (typeof err === 'string' && err) return err;
      if (err && typeof err === 'object') {
        var em = err.message || err.msg || '';
        var ec = err.code || err.type || '';
        if (em) return (ec ? ec + ': ' : '') + em;
        if (ec) return String(ec);
      }
      var msg = j.message || j.msg;
      var code = j.code;
      if (code === 'ERR_INSUFFICIENT_CREDITS' || status === 402) {
        var need = j.required_quota || j.requiredQuota;
        return (msg || '积分不足') + (need ? '（需要 ' + need + '）' : '');
      }
      if (msg && code && String(code) && String(code) !== '200') {
        return String(code) + ': ' + msg;
      }
      if (msg) return String(msg);
    }
    var snippet = raw ? String(raw).replace(/\s+/g, ' ').slice(0, 180) : '';
    return 'HTTP ' + status + (snippet ? ': ' + snippet : '');
  }

  function xhrJsonOk(xhr, j) {
    if (!(xhr.status >= 200 && xhr.status < 300 && j)) return false;
    if (j.code && String(j.code) && String(j.code) !== '200' &&
        !(j.output || j.data)) return false;
    return true;
  }

  /* --------------------------------------------------------------- turn epoch
     Every chat call supersedes the previous one: a reply that resolves after
     the epoch moved on is STALE and must not be applied. That closes AUDIT
     11.4-3 (the retry bar could fire twice and the two replies could land out
     of order), and it is the cancellation channel interruption uses — bumping
     the epoch aborts the XHR still in flight, so an interrupted turn stops
     costing bandwidth instead of merely being ignored. See web/js/turn.js. */
  var _epoch = 0;
  var _inflight = null;      /* { xhr, epoch } */

  function staleError() {
    var e = new Error('STALE');
    e.stale = true;
    return e;
  }

  function abortInflight(reason) {
    if (!_inflight) return false;
    var x = _inflight;
    _inflight = null;
    try { x.xhr.abort(); } catch (e) {}
    return reason != null;
  }

  /* Local engines (VOICEVOX / AivisSpeech) live on another origin
     (127.0.0.1:<port>), so they talk to the engine directly instead of going
     through /_proxy. (They could now — the proxy accepts http:// on loopback
     since 1.2.20 — but a direct call is one hop shorter and the engines are
     already configured for it.) When an engine does not permit the cross-origin
     call, the error it raises says so rather than reporting a bare network
     failure. */
  function localFetch(url, opts) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('NO_FETCH'));
    return fetch(url, opts);
  }

  /* A transport failure used to be a Chinese literal welded into the Error, so
     an Indonesian player read 「请求超时」 — and the caller could only guess at
     the cause from prose (issue #11: the endpoint was simply the wrong address).
     The wording now resolves in the UI language, and the *kind* travels on
     err.code so App can point at the setting without parsing text. */
  function transportError(code) {
    var msg = code;
    try {
      if (typeof I18n !== 'undefined' && I18n.t) msg = I18n.t('api.' + code);
    } catch (e) { /* a locale-less host keeps the bare code */ }
    var err = new Error(msg);
    err.code = code;
    return err;
  }

  function request(url, body, apiKey, timeoutMs, epoch) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var tracked = (epoch != null);
      function untrack() { if (tracked && _inflight && _inflight.xhr === xhr) _inflight = null; }
      xhr.open('POST', url, true);
      xhr.timeout = timeoutMs || 120000;
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (apiKey) {
        xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);
        xhr.setRequestHeader('api-key', apiKey);
      }
      xhr.onload = function () {
        untrack();
        var j = null;
        try { j = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhrJsonOk(xhr, j)) resolve(j);
        else reject(new Error(apiErrorMessage(j, xhr.status, xhr.responseText)));
      };
      xhr.onerror = function () { untrack(); reject(transportError('net')); };
      xhr.ontimeout = function () { untrack(); reject(transportError('timeout')); };
      xhr.onabort = function () { untrack(); reject(staleError()); };
      if (tracked) _inflight = { xhr: xhr, epoch: epoch };
      xhr.send(JSON.stringify(body));
    });
  }

  function requestGet(url, apiKey, timeoutMs, errorMap) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = timeoutMs || 30000;
      if (apiKey) {
        xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);
        xhr.setRequestHeader('api-key', apiKey);
      }
      xhr.onload = function () {
        var j = null;
        try { j = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhrJsonOk(xhr, j)) resolve(j);
        else if (errorMap) reject(new Error(errorMap(xhr.status, xhr.responseText, apiKey)));
        else reject(new Error(apiErrorMessage(j, xhr.status, xhr.responseText)));
      };
      xhr.onerror = function () { reject(transportError('net')); };
      xhr.ontimeout = function () { reject(transportError('timeout')); };
      xhr.send();
    });
  }

  function bufToText(buf) {
    try { return new TextDecoder('utf-8').decode(buf); } catch (e) {
      var u = new Uint8Array(buf || []), s = '', i;
      for (i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return s;
    }
  }

  function audioMimeFrom(buf, contentType) {
    var ct = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (ct.indexOf('audio/') === 0) return ct;
    if (ct.indexOf('mpeg') !== -1) return 'audio/mpeg';
    var u = new Uint8Array(buf || []);
    if (u.length >= 4 && u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46) {
      return 'audio/wav';
    }
    if (u.length >= 3 && u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) return 'audio/mpeg';
    if (u.length >= 2 && u[0] === 0xff && (u[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    return '';
  }

  /* Fish Open API TTS returns audio bytes (or JSON metadata when cache=true). */
  /* Fish names the engine in a header and rejects a request that cannot work
     (401/403/429) with a body that may echo the key, so the message is both
     classified and redacted. `phase` is 'tts' or 'clone'. */
  function redactSecret(value, secret) {
    var out = String(value || '');
    var key = String(secret || '');
    return key ? out.split(key).join('[redacted]') : out;
  }

  /* Two sites of the same name are in the wild and users land on the wrong
     one. fish.audio is the company (docs.fish.audio, api.fish.audio, the free
     s2.1-pro-free engine); fishaudio.org is a different service that happens
     to use the same product name — a key minted on fish.audio does not work
     there. The base URL is never rewritten (a key must not be carried to a
     host it was not issued for), so the 401/403 message says which one the
     request went to instead of leaving the user to guess. */
  function fishHostHint(root) {
    if (!/fishaudio\.org/i.test(String(root || ''))) return '';
    return '（注意：fishaudio.org 不是官方站点，官方接口是 https://api.fish.audio——留空即用官方）';
  }

  function fishErrorMessage(status, raw, apiKey, phase, root) {
    var label = phase === 'clone' ? '音色创建'
      : (phase === 'voices' ? '音色列表' : '语音合成');
    if (status === 401) return 'Fish Audio：API key 无效或缺失（HTTP 401，' + label + '）' + fishHostHint(root);
    if (status === 403) return 'Fish Audio：权限不足、模型不可用或音色无权访问（HTTP 403，' + label + '）' + fishHostHint(root);
    if (status === 429) return 'Fish Audio：超出速率或额度限制（HTTP 429，' + label + '）';
    /* Measured: the API answers 402 not only for a real balance problem but
       also for an engine that is not free (or a misspelled one) — s2-pro and
       s1 are paid, an unknown id is "insufficient credit" too. Saying which
       engine is free is the only actionable half of that message. */
    if (status === 402) {
      return 'Fish Audio：这个引擎需要 API 额度（HTTP 402）——免费只有 s2.1-pro-free；'
           + '付费引擎/写错的引擎名都会报这个。充值入口在 fish.audio 的开发者页。';
    }
    var j = null;
    try { j = JSON.parse(String(raw || '')); } catch (e) {}
    var detail = redactSecret(apiErrorMessage(j, status, raw), apiKey);
    /* 400 "Reference not found"：the voice id is not one this account can use
       (a public voice id copied from somewhere else, or a stale one). */
    if (status === 400 && /reference not found/i.test(String(raw || ''))) {
      return 'Fish Audio：音色 ID 无效或不属于这个账号（HTTP 400）——'
           + '请在 fish.audio 里复制自己音色的 id，或留空用默认音色。';
    }
    return 'Fish Audio ' + label + '失败' + (detail ? '：' + detail : '（HTTP ' + status + '）');
  }

  function requestAudio(url, body, apiKey, timeoutMs, extraHeaders, errorMap) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.timeout = timeoutMs || 180000;
      xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (apiKey) {
        xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);
        xhr.setRequestHeader('api-key', apiKey);
      }
      Object.keys(extraHeaders || {}).forEach(function (name) {
        xhr.setRequestHeader(name, extraHeaders[name]);
      });
      xhr.onload = function () {
        var buf = xhr.response;
        var ct = xhr.getResponseHeader('Content-Type') || '';
        var mime = audioMimeFrom(buf, ct);
        if (xhr.status >= 200 && xhr.status < 300 && mime) {
          resolve(URL.createObjectURL(new Blob([buf], { type: mime })));
          return;
        }
        var raw = bufToText(buf);
        var j = null;
        try { j = JSON.parse(raw); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && j && (j.audio_url || j.audioUrl)) {
          Api._downloadUrl(j.audio_url || j.audioUrl, apiKey).then(resolve, reject);
          return;
        }
        reject(new Error(errorMap
          ? errorMap(xhr.status, raw, apiKey)
          : apiErrorMessage(j, xhr.status, raw)));
      };
      xhr.onerror = function () { reject(transportError('net')); };
      xhr.ontimeout = function () { reject(transportError('timeout')); };
      xhr.send(JSON.stringify(body));
    });
  }

  function requestForm(url, form, apiKey, timeoutMs, errorMap) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.timeout = timeoutMs || 180000;
      if (apiKey) xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);
      xhr.onload = function () {
        var j = null;
        try { j = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhrJsonOk(xhr, j)) resolve(j);
        else reject(new Error(errorMap
          ? errorMap(xhr.status, xhr.responseText, apiKey)
          : apiErrorMessage(j, xhr.status, xhr.responseText)));
      };
      xhr.onerror = function () { reject(transportError('net')); };
      xhr.ontimeout = function () { reject(transportError('timeout')); };
      xhr.send(form);
    });
  }

  /* Same DashScope HTTP protocol, different hosts: official Beijing,
     Singapore, workspace MaaS, or a reverse-proxy that mirrors the
     /api/v1/services/... paths. Users paste whatever the console copied
     (host root, /api/v1, compatible-mode/v1, even a full TTS URL). */
  var QWEN_DEFAULT_BASE = 'https://dashscope.aliyuncs.com';
  var QWEN_TTS_MODELS = [
    'qwen3-tts-flash',
    'qwen3-tts-instruct-flash',
    'qwen3-tts-vc-2026-01-22',
    'qwen-audio-3.0-tts-flash',
    'qwen-audio-3.0-tts-plus',
    'cosyvoice-v3-flash',
    'cosyvoice-v3.5-flash',
    'cosyvoice-v3.5-plus'
  ];
  var QWEN_TTS_VOICES = [
    'Cherry', 'Serena', 'Chelsie', 'Ethan', 'longanhuan_v3.6'
  ];

  function qwenApiRoot(baseUrl) {
    var s = String(baseUrl || '').trim();
    if (!s) s = QWEN_DEFAULT_BASE;
    s = s.replace(/\/+$/, '');
    s = s.replace(/\/api\/v1\/services\/[^?#]*/i, '');
    s = s.replace(/\/compatible-mode\/v1$/i, '');
    s = s.replace(/\/compatible-mode$/i, '');
    s = s.replace(/\/api\/v1$/i, '');
    /* OpenAI-compat copy-paste: https://gateway.example/v1 */
    if (!/\/api\/v1$/i.test(s)) s = s.replace(/\/v1$/i, '');
    return s.replace(/\/+$/, '');
  }

  function qwenTtsKind(model) {
    var m = String(model || '').toLowerCase();
    if (/voice-enrollment|qwen-voice-enrollment|qwen-voice-design/.test(m)) {
      return 'enroll';
    }
    if (/cosyvoice|qwen-audio/.test(m)) return 'speech';
    return 'multimodal';
  }

  function qwenTtsPath(model) {
    var k = qwenTtsKind(model);
    if (k === 'speech') return '/api/v1/services/audio/tts/SpeechSynthesizer';
    if (k === 'enroll') return '/api/v1/services/audio/tts/customization';
    return '/api/v1/services/aigc/multimodal-generation/generation';
  }

  function qwenTtsUrl(baseUrl, model) {
    return qwenApiRoot(baseUrl) + qwenTtsPath(model);
  }

  function qwenHttpsUrl(url) {
    return String(url || '').replace(/^http:\/\//i, 'https://');
  }

  /* Fish Audio (https://docs.fish.audio). Credentials are separate from
     openai/qwen so switching providers never mixes keys.

     Two surfaces are in the wild and users land on different ones:
       * current        — https://api.fish.audio + POST /v1/tts, engine named
                          in a `model` header, body {text, reference_id, format}
       * older Open API — /api/open/v1 + POST /speech/tts, engine named in the
                          body (voiceId / reference_id / modelId)
     The base URL now picks the surface. Pasting https://api.fish.audio used to
     be silently rewritten to the other host, which sent the key somewhere it
     does not work and surfaced as a confusing failure (issues #6 / #7).
     fishVoice is a speaker id；fishModel is the engine (per surface).

     The EMPTY field must not fall back to the older host: that host is
     fishaudio.org, a same-name service that is not the one with the free
     s2.1-pro-free engine, so "leave it blank and just fill the key" — the
     most natural thing a user does — landed on a site their key does not
     belong to (reported again on the 1.2.20 APK). Blank = the official
     current API now; a legacy deployment still works by typing its URL. */
  var FISH_MODERN_BASE = 'https://api.fish.audio';
  var FISH_LEGACY_BASE = 'https://fishaudio.org/api/open/v1';
  var FISH_DEFAULT_BASE = FISH_MODERN_BASE;
  var FISH_MODERN_DEFAULT_MODEL = 's2.1-pro-free';
  var FISH_LEGACY_DEFAULT_MODEL = 'fishaudio-s21pro-flash';
  var FISH_DEFAULT_VOICE = '';
  var FISH_TTS_MODELS = [
    /* the current API's engines (api.fish.audio, named in the `model` header) */
    's2.1-pro-free',
    's2-pro',
    's1',
    /* the older Open API's engines (named in the body) */
    'fishaudio-s21pro-flash',
    'fishaudio-s21pro',
    'fishaudio-s2pro',
    'fishaudio-s1',
    'minimax-2.8-turbo',
    'minimax-2.8-hd',
    'minimax-2.6-turbo',
    'minimax-2.6-hd',
    'qwen3-tts-flash',
    'qwen-audio-3.0-tts-plus',
    'qwen-audio-3.0-tts-flash',
    'cosyvoice-v3-flash',
    'doubao-tts-2.0'
  ];

  /* Tolerate whatever the settings field was handed: the host root, the
     documented /v1/tts endpoint, a pasted .../v1, or a legacy /api/open/v1.
     The surface then follows from the resolved root — it is decided here and
     nowhere else. */
  function fishApiRoot(baseUrl) {
    var s = String(baseUrl || '').trim();
    if (!s) return FISH_DEFAULT_BASE;
    s = s.replace(/\/+$/, '');
    s = s.replace(/\/speech\/tts\/jobs$/i, '');
    s = s.replace(/\/speech\/tts$/i, '');
    s = s.replace(/\/v1\/tts$/i, '');
    /* An explicit legacy base wins before the bare /v1 strip below eats it. */
    if (/\/api\/open\/v\d+$/i.test(s)) return s;
    s = s.replace(/\/v1$/i, '');
    if (/^https?:\/\/(api\.)?fish\.audio$/i.test(s)) return FISH_MODERN_BASE;
    if (/^https?:\/\/fishaudio\.org$/i.test(s)) return FISH_LEGACY_BASE;
    if (/fishaudio\.org$/i.test(s)) return s + '/api/open/v1';
    return s;
  }

  /* Which surface a resolved root speaks. Only the decision lives here; the
     request shape follows from it in _fishSpeak. */
  function fishApiStyle(root) {
    return /api\.fish\.audio/i.test(String(root || '')) ? 'modern' : 'legacy';
  }

  function fishTtsUrl(baseUrl) {
    var root = fishApiRoot(baseUrl);
    return fishApiStyle(root) === 'modern' ? root + '/v1/tts' : root + '/speech/tts';
  }

  /* Which voice id a mode speaks with. ASMR has its own id when the user set
     one (the source ties the whisper register to the outfit; a second hosted
     voice is the closest a TTS API gets), otherwise the normal one. Empty
     here means "clone from the local samples" exactly as before. */
  function fishVoiceFor(tts, mode) {
    tts = tts || {};
    var asmr = String(tts.fishVoiceAsmr || '').trim();
    if (String(mode || '') === 'asmr' && asmr) return asmr;
    return String(tts.fishVoice || '').trim();
  }

  function fishLanguage(lg) {
    var map = {
      ja: 'ja', zh: 'zh', 'zh-tw': 'zh-TW', en: 'en',
      hi: 'hi', id: 'id', 'pt-br': 'pt-BR'
    };
    return map[lg] || '';
  }

  function fishWantsInstruction(model) {
    return /qwen-audio/i.test(String(model || ''));
  }

  function fishWantsEmotion(model) {
    return /minimax/i.test(String(model || ''));
  }

  /* Fish takes an emotion tag alongside the text. The caller knows the current
     face (it just set it), so it is passed in — the transport layer must not
     read renderer state. */
  function fishEmotion(emotion) {
    var e = String(emotion || '');
    var map = {
      happy: 'happy', laughing: 'happy', tease: 'surprised',
      shy: 'calm', cuddle: 'calm', sad: 'sad', crying: 'sad',
      angry: 'angry', neutral: 'calm'
    };
    return map[e] || '';
  }

  /* Local Ryza samples for Open API clone. Prefer converted wav if present,
     otherwise the shipped Japanese prologue m4a (Fish accepts m4a). */
  function fishSampleUrls() {
    var tts = {};
    try { tts = (window.Config && Config.section('tts')) || {}; } catch (e) { tts = {}; }
    var urls = [], seen = {};
    function add(u) {
      u = String(u || '').trim();
      if (!u || seen[u]) return;
      seen[u] = 1;
      urls.push(u);
    }
    add(tts.reference);
    var i, n;
    for (i = 1; i <= 9; i++) {
      n = (i < 10 ? '0' : '') + i;
      add('assets/voice/ryza_wav/prologue_' + n + '.wav');
      add('assets/audio/prologue/jp/prologue_' + n + '.m4a');
    }
    return urls;
  }

  var _fishCloneWait = null;

  function qwenDefaultVoice(model, current) {
    var m = String(model || '').toLowerCase();
    var v = String(current || '').trim();
    var audioFamily = /qwen-audio|cosyvoice/.test(m);
    if (!v) return audioFamily ? 'longanhuan_v3.6' : 'Cherry';
    if (audioFamily && /^cherry$/i.test(v)) return 'longanhuan_v3.6';
    if (!audioFamily && /longanhuan/i.test(v) && /qwen3-tts|qwen-tts/.test(m)) {
      return 'Cherry';
    }
    return v;
  }

  function qwenWantsInstructions(model) {
    var m = String(model || '').toLowerCase();
    if (/qwen3-tts-vc|qwen-tts-vc/.test(m)) return false;
    if (/instruct/.test(m)) return true;
    if (/qwen-audio/.test(m)) return true;
    if (/cosyvoice-v3\.5|cosyvoice-v3-flash/.test(m)) return true;
    return false;
  }

  function isQwenHttpTtsModelId(id) {
    id = String(id || '').toLowerCase();
    if (/realtime/.test(id)) return false;
    return /tts|cosyvoice|qwen-audio|speech|voice-enrollment|qwen-voice/.test(id);
  }

  function parseQwenModelList(j) {
    var raw = (j && (j.data || j.models)) || [];
    if (!Array.isArray(raw) && j && j.output && Array.isArray(j.output.models)) {
      raw = j.output.models;
    }
    if (!Array.isArray(raw)) raw = [];
    var out = [], seen = {};
    raw.forEach(function (m) {
      var e = parseModelEntry(m);
      if (!e || !e.id || seen[e.id] || !isQwenHttpTtsModelId(e.id)) return;
      seen[e.id] = 1;
      out.push(e);
    });
    out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return out;
  }

  function choiceText(j) {
    var m = j && j.choices && j.choices[0] && j.choices[0].message;
    if (!m) return '';
    var c = m.content;
    if (typeof c === 'string' && c.trim()) return c;
    if (Array.isArray(c)) {
      var joined = c.map(function (p) {
        return (p && (p.text || p.content || '')) || '';
      }).join('');
      if (joined.trim()) return joined;
    }
    if (typeof m.reasoning_content === 'string' && m.reasoning_content.trim()) {
      return m.reasoning_content;
    }
    if (typeof m.reasoning === 'string' && m.reasoning.trim()) {
      return m.reasoning;
    }
    if (typeof c === 'string') return c;
    return '';
  }

  /* CJK-heavy estimator. Used only as a budget fence, not a billing meter. */
  function estTokens(s) {
    s = String(s || '');
    var n = 0, i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      n += c > 127 ? 1.15 : 0.35;
    }
    return Math.ceil(n);
  }

  function estMessages(msgs) {
    var t = 0, i;
    for (i = 0; i < msgs.length; i++) t += 8 + estTokens(msgs[i] && msgs[i].content);
    return t;
  }

  function guessContext(id) {
    id = String(id || '').toLowerCase();
    if (/gpt-5|gpt-4\.1|o3|o4|o1/.test(id)) return 200000;
    if (/gpt-4o|gpt-4-turbo|chatgpt-4o/.test(id)) return 128000;
    if (/gpt-3\.5/.test(id)) return 16385;
    if (/claude/.test(id)) return 200000;
    if (/gemini/.test(id)) return 128000;
    if (/deepseek/.test(id)) return 65536;
    if (/qwen3|qwen2\.5|qwen2/.test(id)) return 32768;
    if (/qwen/.test(id)) return 32768;
    if (/llama-?3\.1|llama3\.1/.test(id)) return 131072;
    if (/mistral|mixtral/.test(id)) return 32768;
    return 0;
  }

  function parseContextField(m) {
    if (!m || typeof m !== 'object') return 0;
    var n = Number(m.context_length || m.max_model_len || m.context_window ||
                   m.max_context ||
                   (m.limit && (m.limit.context || m.limit.context_length)) ||
                   (m.top_provider && m.top_provider.context_length) ||
                   (m.meta && (m.meta.n_ctx || m.meta.max_model_len)) ||
                   (m.architecture && m.architecture.context_length) || 0);
    return n > 1024 ? Math.floor(n) : 0;
  }

  /* One UI ladder. Wire tokens differ per URL; map at send time.
     `default` = do not send an intensity field (endpoint native / unmodifiable). */
  var EFFORT_RANK = {
    default: -1,
    off: 0, none: 0, disabled: 0,
    low: 1, minimal: 1, min: 1,
    medium: 2, mid: 2,
    high: 3,
    xhigh: 4,
    max: 5
  };
  var EFFORT_UI = ['default', 'off', 'low', 'medium', 'high', 'max'];
  var QWEN_BUDGET = { low: 512, medium: 2048, high: 8192, max: 32768 };

  function normalizeEffort(v) {
    var s = String(v == null ? '' : v).toLowerCase().trim();
    if (!s) return 'default';
    if (s === 'none' || s === 'disabled' || s === 'false') return 'off';
    if (s === 'minimal' || s === 'min') return 'low';
    if (s === 'mid') return 'medium';
    if (s === 'extra-high' || s === 'extra_high' || s === 'extra high') return 'xhigh';
    return Object.prototype.hasOwnProperty.call(EFFORT_RANK, s) ? s : 'default';
  }

  function effortRank(v) {
    var n = normalizeEffort(v);
    return EFFORT_RANK[n] != null ? EFFORT_RANK[n] : -1;
  }

  /* Pick the closest token from `available` (provider vocabulary).
     Returns null for `default` or when there is nothing to send. */
  function mapEffort(wanted, available) {
    var w = normalizeEffort(wanted);
    if (w === 'default') return null;
    var list = [];
    if (Array.isArray(available)) {
      available.forEach(function (tok) {
        if (tok == null || tok === '') return;
        var s = String(tok);
        if (list.indexOf(s) === -1) list.push(s);
      });
    }
    if (!list.length) return null;
    var i, tok, d, r, best = null, bestD = 1e9, bestR = -1;
    var wr = effortRank(w);
    for (i = 0; i < list.length; i++) {
      tok = list[i];
      if (normalizeEffort(tok) === w) return tok;
    }
    if (wr < 0) return null;
    for (i = 0; i < list.length; i++) {
      tok = list[i];
      r = effortRank(tok);
      if (r < 0) continue;
      d = Math.abs(r - wr);
      if (d < bestD || (d === bestD && r > bestR)) {
        bestD = d;
        bestR = r;
        best = tok;
      }
    }
    return best;
  }

  function parseEffortList(m) {
    if (!m || typeof m !== 'object') return [];
    var out = [];
    function add(v) {
      if (v == null || v === '') return;
      var s = String(v);
      if (out.indexOf(s) === -1) out.push(s);
    }
    var raw = m.reasoning_options || m.reasoning_effort_options ||
              m.supported_reasoning_efforts || m.efforts;
    if (typeof raw === 'string') raw = [raw];
    if (Array.isArray(raw)) {
      raw.forEach(function (o) {
        if (o == null) return;
        if (typeof o === 'string') add(o);
        else if (Array.isArray(o.values) && (o.type === 'effort' || !o.type)) {
          o.values.forEach(add);
        }
      });
    }
    var params = m.supported_parameters || m.supported_params;
    if (typeof params === 'string') params = [params];
    return out;
  }

  function guessEffortList(id, style) {
    id = String(id || '').toLowerCase();
    if (style === 'glm' || /glm-?5/.test(id)) return ['low', 'high', 'max'];
    if (style === 'qwen') return ['off', 'low', 'medium', 'high', 'max'];
    if (style === 'openai' || style === 'openrouter' ||
        /^(o1|o3|o4|gpt-5)/.test(id) || /gpt-5/.test(id)) {
      return ['none', 'low', 'medium', 'high', 'xhigh'];
    }
    return [];
  }

  function protocolEffortList(style, meta, id) {
    if (meta && meta.efforts && meta.efforts.length) return meta.efforts;
    return guessEffortList(id, style);
  }

  function parseModelEntry(m) {
    if (!m) return null;
    if (typeof m === 'string') m = { id: m };
    var id = m.id || m.name || '';
    if (!id) return null;
    var params = m.supported_parameters || m.supported_params || [];
    if (typeof params === 'string') params = [params];
    var thinking = false;
    if (Array.isArray(params)) {
      thinking = params.indexOf('reasoning') !== -1 ||
                 params.indexOf('include_reasoning') !== -1 ||
                 params.indexOf('reasoning_effort') !== -1 ||
                 params.indexOf('enable_thinking') !== -1;
    }
    if (m.architecture && m.architecture.instruct_type === 'deepseek-r1') thinking = true;
    if (m.reasoning === true || m.thinking === true) thinking = true;
    var efforts = parseEffortList(m);
    if (efforts.length) thinking = true;
    var ro = m.reasoning_options;
    if (Array.isArray(ro)) {
      ro.forEach(function (o) {
        if (o && o.type === 'toggle') thinking = true;
      });
    }
    return {
      id: id,
      context: parseContextField(m) || guessContext(id),
      thinking: thinking,
      efforts: efforts
    };
  }

  function detectThinkingStyle(llm, meta, modelId) {
    var style = (llm && llm.thinkingStyle) || 'auto';
    if (style && style !== 'auto') return style;
    var url = String((llm && llm.baseUrl) || '');
    var id = String(modelId || (llm && llm.model) || (meta && meta.id) || '');
    if (meta && meta.style && meta.style !== 'auto') return meta.style;
    if (/openrouter\.ai/i.test(url)) return 'openrouter';
    if (/dashscope|aliyuncs/i.test(url)) return 'qwen';
    if (/bigmodel\.cn|zhipuai/i.test(url) || /glm-?5/i.test(id)) return 'glm';
    if (/qwq|qwen.*think/i.test(id)) return 'qwen';
    if (meta && meta.thinking) return /openrouter/i.test(url) ? 'openrouter' : 'openai';
    if (/^(o1|o3|o4|gpt-5)/i.test(id) || /reasoner|r1|qwq/i.test(id)) {
      return /qwen|dashscope/i.test(url + id) ? 'qwen' : 'openai';
    }
    return 'none';
  }

  function qwenBudget(mapped) {
    var n = normalizeEffort(mapped);
    if (n === 'off' || n === 'default') return 0;
    if (n === 'xhigh') n = 'max';
    return QWEN_BUDGET[n] || QWEN_BUDGET.medium;
  }

  function attachThinking(body, llm, meta) {
    var mode = (llm && llm.thinking) || 'auto';
    var id = String((llm && llm.model) || (body && body.model) || (meta && meta.id) || '');
    var style = detectThinkingStyle(llm, meta, id);
    var wanted = normalizeEffort(llm && llm.thinkingEffort);
    if (mode === 'off') wanted = 'off';
    if (style === 'none') return body;
    var available = protocolEffortList(style, meta, id);
    var mapped = mapEffort(wanted, available);

    if (wanted === 'default') {
      if (mode !== 'on') return body;
      if (style === 'qwen') {
        body.enable_thinking = true;
        return body;
      }
      if (style === 'glm') {
        body.thinking = { type: 'enabled' };
        return body;
      }
      return body;
    }

    if (style === 'openai') {
      if (mapped) body.reasoning_effort = mapped;
      return body;
    }
    if (style === 'openrouter') {
      if (mapped) body.reasoning = { effort: mapped };
      return body;
    }
    if (style === 'qwen') {
      if (wanted === 'off' || normalizeEffort(mapped) === 'off') {
        body.enable_thinking = false;
        return body;
      }
      body.enable_thinking = true;
      var budget = qwenBudget(mapped || wanted);
      if (budget > 0) body.thinking_budget = budget;
      return body;
    }
    if (style === 'glm') {
      body.thinking = { type: 'enabled' };
      if (mapped) body.reasoning_effort = mapped;
      return body;
    }
    return body;
  }

  var _modelMeta = null;

  function resolvedContext(llm) {
    var n = Number(llm && llm.contextWindow);
    if (n > 1024) return Math.floor(n);
    if (_modelMeta && _modelMeta.id === (llm && llm.model) && _modelMeta.context > 1024) {
      return _modelMeta.context;
    }
    return guessContext(llm && llm.model) || 32768;
  }

  var Api = {
    EMOTIONS: EMOTIONS,
    ATTITUDES: ATTITUDES,
    MODE_TTS: MODE_TTS,
    MODE_PLAY_FX: MODE_PLAY_FX,
    parseTaggedReply: parseTaggedReply,
    buildSystemPrompt: buildSystemPrompt,
    screenTagLine: screenTagLine,
    withTurnCue: withTurnCue,
    formatHistoryReply: formatHistoryReply,
    extractState: extractState,
    isPlaceholderModel: isPlaceholderModel,
    estTokens: estTokens,
    guessContext: guessContext,
    parseModelEntry: parseModelEntry,
    detectThinkingStyle: detectThinkingStyle,
    attachThinking: attachThinking,
    normalizeEffort: normalizeEffort,
    mapEffort: mapEffort,
    EFFORT_UI: EFFORT_UI,
    setModelMeta: function (m) { _modelMeta = m || null; },
    /* fn() -> { emotion, attitude } — the host supplies what is on screen, so
       the protocol layer never reads the render layer. */
    setScreenState: function (fn) { _screenState = (typeof fn === 'function') ? fn : null; },
    resolvedContext: function () { return resolvedContext(Config.section('llm')); },
    /* test seam: which calls get rewritten onto the same-origin /_proxy
       (nsfw_intent_regression asserts serve.py + ryza://app both route) */
    _localProxy: localProxy,
    QWEN_DEFAULT_BASE: QWEN_DEFAULT_BASE,
    QWEN_TTS_MODELS: QWEN_TTS_MODELS,
    QWEN_TTS_VOICES: QWEN_TTS_VOICES,
    _qwenApiRoot: qwenApiRoot,
    _qwenTtsUrl: qwenTtsUrl,
    _qwenHttpsUrl: qwenHttpsUrl,
    _qwenTtsKind: qwenTtsKind,
    _qwenDefaultVoice: qwenDefaultVoice,
    FISH_DEFAULT_BASE: FISH_DEFAULT_BASE,
    FISH_MODERN_BASE: FISH_MODERN_BASE,
    FISH_DEFAULT_VOICE: FISH_DEFAULT_VOICE,
    FISH_TTS_MODELS: FISH_TTS_MODELS,
    _fishApiRoot: fishApiRoot,
    _fishApiStyle: fishApiStyle,
    _fishTtsUrl: fishTtsUrl,
    _fishVoiceFor: fishVoiceFor,
    FISH_DEFAULT_BASE: FISH_DEFAULT_BASE,
    FISH_MODERN_BASE: FISH_MODERN_BASE,
    FISH_LEGACY_BASE: FISH_LEGACY_BASE,
    _fishErrorMessage: fishErrorMessage,
    _fishLanguage: fishLanguage,
    _fishSampleUrls: fishSampleUrls,
    /* resolved per-mode TTS voice direction (base hint + mode layer) */
    ttsStyleFor: function (mode) { return ttsStyleFor(mode, Config.section('tts')); },
    /* speech input: stt.js gets this as an injected port */
    transcribe: transcribe,

    /* resolved reply language (auto = UI) */
    replyLang: function () {
      return (window.Langs && Langs.llm()) || 'ja';
    },

    /* ------------------------------------------------- translate channel
       Used when the TTS language differs from the reply language: the
       displayed text stays, the spoken text is re-voiced in another
       language by the same LLM. */
    translate: function (text, toLang) {
      if (!text || !toLang || toLang === Api.replyLang()) {
        return Promise.resolve(text);
      }
      var llm = Config.section('llm');
      if (!llm.apiKey) return Promise.resolve(text);
      return request(localProxy(upstreamUrl(llm.baseUrl, '/chat/completions')), {
        model: llm.model,
        messages: [
          { role: 'system', content: 'You are a translator for a Japanese anime game character (Ryza, cheerful young alchemist). Translate her line into ' + langName(toLang) + ', keeping the playful spoken tone, first-person feel and emotion. Output ONLY the translated line — no quotes, notes or tags.' },
          { role: 'user', content: text }
        ],
        temperature: 0.3,
        max_tokens: Math.max(80, (llm.maxTokens || 400))
      }, llm.apiKey, 60000).then(function (j) {
        var c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        return (c && String(c).trim()) || text;
      }).catch(function () { return text; });
    },

    /* ------------------------------------------------------------- LLM */
    /* ---------------------------------------------------------- turn epoch
       Turn.newTurn / App own the decision to start a turn; this is the counter
       and the abort. Kept on Api because aborting the request is a transport
       concern — turn.js never learns what HTTP is. */
    turnEpoch: function () { return _epoch; },
    newTurn: function (reason) { _epoch++; abortInflight(reason); return _epoch; },
    isStale: function (e) { return e !== _epoch; },
    abortInflight: abortInflight,

    chat: function (history, userText, opts) {
      var llm = Config.section('llm');
      if (!llm.apiKey) return Promise.reject(new Error('NO_KEY'));
      opts = opts || {};
      /* A side call (dynamically generated quest text, the settings "test LLM"
         button) must not allocate an epoch. Allocating one aborted whatever the
         player had in flight, and App.say's own handler treats the resulting
         STALE as "superseded on purpose" and returns silently — so the player's
         message disappeared with no answer, no toast and no retry. `standalone`
         calls are neither tracked nor superseded.
         No epoch and not standalone (a boot greeting, an alarm line)? Then this
         call is its own turn and still gets stale protection. */
      var standalone = opts.standalone === true;
      var epoch = standalone ? null
                : ((opts.epoch != null) ? opts.epoch : Api.newTurn());
      var st = Config.section('state');
      var outLang = opts.lang || Api.replyLang();
      var mem = '';
      try { if (window.Memory) mem = Memory.promptBlock() || ''; } catch (e) { mem = ''; }
      /* 长期记忆（条目 + 摘要）独立于近窗卡片：digest 永远注入，条目按本轮
         用户说的话做相关度挑选。没有这一层，三个月前的约定就再也想不起来。 */
      try {
        if (window.LongTerm) {
          var lt = LongTerm.promptBlock(opts.cue || '');
          if (lt) mem = mem ? (mem + String.fromCharCode(10, 10) + lt) : lt;

        }
      } catch (e) { /* 记忆层不许拖垮对话 */ }
      var system = buildSystemPrompt(opts.mode || st.mode, opts.style || st.style,
                                     opts.rpgContext || '', outLang, opts.nsfwSection || '',
                                     opts.sceneSection || '', mem, (history || []).length);
      var keep = Math.max(0, (llm.historyTurns || 12) * 2);
      var hist = (history || []).slice(-keep);
      var ctx = resolvedContext(llm);
      var reserve = Math.max(256, Number(llm.maxTokens) || 400) + 96;
      var budget = Math.max(1024, ctx - reserve);
      function pack(h) {
        return [{ role: 'system', content: system }]
          .concat(h)
          .concat([{ role: 'user', content: withTurnCue(userText) }]);
      }
      var used = estMessages(pack(hist));
      while (hist.length > 2 && used > budget) {
        hist = hist.slice(2);
        used = estMessages(pack(hist));
      }
      if (used > budget * 0.85) {
        try { if (window.Memory) Memory.notifyPressure(); } catch (e) {}
      }
      var body = {
        model: llm.model, messages: pack(hist),
        temperature: Number(llm.temperature) || 0.9,
        max_tokens: Number(llm.maxTokens) || 1024
      };
      attachThinking(body, llm, _modelMeta && _modelMeta.id === llm.model ? _modelMeta : null);
      return request(localProxy(upstreamUrl(llm.baseUrl, '/chat/completions')),
                     body, llm.apiKey, undefined, epoch == null ? undefined : epoch).then(function (j) {
        /* Interrupted / superseded while the request was in flight: the reply
           must not reach the caller at all (no history push, no face change,
           no speech). */
        if (epoch != null && Api.isStale(epoch)) throw staleError();
        return parseTaggedReply(choiceText(j));
      });
    },

    /* Short completion without persona / tags / thinking — memory rollup. */
    complete: function (system, user, opts) {
      opts = opts || {};
      var llm = Config.section('llm');
      if (!llm.apiKey) return Promise.reject(new Error('NO_KEY'));
      return request(localProxy(upstreamUrl(llm.baseUrl, '/chat/completions')), {
        model: llm.model,
        messages: [
          { role: 'system', content: String(system || '') },
          { role: 'user', content: String(user || '') }
        ],
        temperature: opts.temperature != null ? opts.temperature : 0.2,
        max_tokens: opts.maxTokens || 280
      }, llm.apiKey, opts.timeout || 60000).then(function (j) {
        return String(choiceText(j) || '').trim();
      });
    },

    listModels: function () {
      var llm = Config.section('llm');
      if (!llm.apiKey) return Promise.reject(new Error('NO_KEY'));
      if (!llm.baseUrl) return Promise.reject(new Error('NO_URL'));
      return requestGet(localProxy(upstreamUrl(llm.baseUrl, '/models')), llm.apiKey, 20000)
        .then(function (j) {
          var raw = (j && (j.data || j.models || j.data && j.data.data)) || [];
          if (!Array.isArray(raw)) raw = [];
          var out = [];
          raw.forEach(function (m) {
            var e = parseModelEntry(m);
            if (e) out.push(e);
          });
          out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
          var cur = out.filter(function (e) { return e.id === llm.model; })[0];
          _modelMeta = cur || (out[0] || null);
          return out;
        });
    },

    /* DashScope-compatible hosts rarely put TTS ids on /v1/models, so this
       also tries compatible-mode, then filters to HTTP (non-realtime) speech
       models. Empty result is not a failure — the user can type any id. */
    listQwenTtsModels: function () {
      var tts = Config.section('tts');
      if (!tts.qwenApiKey) return Promise.reject(new Error('NO_KEY'));
      var root = qwenApiRoot(tts.qwenBaseUrl);
      var urls = [
        root + '/compatible-mode/v1/models',
        root + '/api/v1/models'
      ];
      function pull(i) {
        if (i >= urls.length) return Promise.resolve([]);
        return requestGet(localProxy(urls[i]), tts.qwenApiKey, 20000)
          .then(function (j) {
            var list = parseQwenModelList(j);
            if (list.length) return list;
            return pull(i + 1);
          })
          .catch(function () { return pull(i + 1); });
      }
      return pull(0);
    },

    /* ------------------------------------------------------------- TTS */
    /* Resolves to a Blob URL. Returns null when voice is disabled.
       provider: 'openai' (chat/completions + audio, MiMo-style),
       'qwen' (DashScope-compatible TTS), or 'fish' (Fish Audio Open API
       POST /speech/tts, binary audio). `mode` is the talk mode; `emotion` is
       the face currently on screen (Fish tags its delivery with it). */
    speak: function (text, lang, mode, emotion) {
      var tts = Config.section('tts');
      if (tts.mode === 'off') return Promise.resolve(null);
      mode = mode || (Config.section('state') || {}).mode || 'chat';
      /* Which credentials belong to which provider is declared in
         web/js/providers.js and resolved once here. The hand-written
         per-provider branches were what let a provider switch keep reading the
         previous endpoint (AUDIT 6.9). */
      var cred = Providers.credentials(tts);
      if (cred.capabilities.local) {
        return Providers.speakLocal(cred, { text: text, fetch: localFetch });
      }
      if (cred.id === 'qwen') return Api._qwenSpeak(text, lang, mode);
      if (cred.id === 'fish') return Api._fishSpeak(text, lang, mode, emotion);
      if (!cred.apiKey) return Promise.reject(new Error('NO_KEY'));
      if (!tts.apiKey) return Promise.reject(new Error('NO_KEY'));

      var audio = { format: tts.format || 'wav' };
      if (tts.mode === 'clone') {
        audio.voice = 'pending';   // filled in below, once the wav is base64'd
      } else {
        audio.voice = cred.voice || 'Chloe';
      }

      var model = cred.model;
      /* The shipped defaults are placeholders; sending them yields the
         server's confusing "unsupported model tts-model". Fail locally with
         a clear, translated toast instead. */
      if (isPlaceholderModel(model)) {
        return Promise.reject(new Error('NO_MODEL'));
      }
      var styleHint = ttsStyleFor(mode, tts);

      function send(voiceField) {
        audio.voice = voiceField;
        return request(localProxy(upstreamUrl(cred.baseUrl, '/chat/completions')), {
          model: model,
          messages: [
            { role: 'user', content: styleHint },
            { role: 'assistant', content: text }
          ],
          audio: audio
        }, cred.apiKey, 180000).then(function (j) {
          var msg = j.choices && j.choices[0] && j.choices[0].message;
          var data = msg && msg.audio && msg.audio.data;
          if (!data) throw new Error('接口未返回音频');
          return Api._b64ToUrl(data, tts.format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
        });
      }

      if (tts.mode === 'clone') {
        return Api._fetchAsDataUrl(tts.reference).then(send);
      }
      return send(audio.voice);
    },

    /* ------------------------------------------- Qwen / Bailian (DashScope) */
    _qwenSpeak: function (text, lang, mode) {
      var tts = Config.section('tts');
      if (!tts.qwenApiKey) return Promise.reject(new Error('NO_KEY'));
      var lg = lang || (window.Langs ? Langs.tts() : 'ja');
      var langType = window.Langs ? Langs.ttsLangType(lg) : 'Auto';
      var model = String(tts.qwenModel || 'qwen3-tts-flash').trim() || 'qwen3-tts-flash';
      var kind = qwenTtsKind(model);
      var voice = qwenDefaultVoice(model, tts.qwenVoice);
      var input = { text: text, voice: voice };
      if (kind === 'speech') {
        input.format = 'wav';
        input.sample_rate = 24000;
        if (/qwen-audio/i.test(model)) input.language_type = langType;
      } else {
        input.language_type = langType;
      }
      if (qwenWantsInstructions(model)) {
        var style = ttsStyleFor(mode || 'chat', tts);
        if (style) {
          if (kind === 'speech') input.instruction = style;
          else input.instructions = style;
        }
      }
      return request(localProxy(qwenTtsUrl(tts.qwenBaseUrl, model)), {
        model: model,
        input: input
      }, tts.qwenApiKey, 180000).then(function (j) {
        var aud = j && j.output && j.output.audio;
        var data = aud && String(aud.data || '').trim();
        var url = aud && aud.url;
        if (data) return Api._b64ToUrl(data, 'audio/wav');
        if (url) return Api._downloadUrl(url);
        throw new Error('Qwen TTS 未返回音频');
      });
    },

    /* DashScope often returns an http:// OSS URL. The local /_proxy only
       forwards https, and Android cleartext is blocked — rewrite first.
       Fish cached TTS URLs need the same Bearer key. */
    _downloadUrl: function (url, apiKey) {
      var headers = {};
      if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
      return fetch(localProxy(qwenHttpsUrl(url)), { headers: headers }).then(function (r) {
        if (!r.ok) throw new Error('音频下载失败 HTTP ' + r.status);
        return r.blob();
      }).then(function (blob) { return URL.createObjectURL(blob); });
    },

    /* ------------------------------------------- Fish Audio Open API TTS */
    _fishSpeak: function (text, lang, mode, emotion) {
      var tts = Config.section('tts');
      if (!tts.fishApiKey) return Promise.reject(new Error('NO_KEY'));
      var root = fishApiRoot(tts.fishBaseUrl);
      var style = fishApiStyle(root);

      function synthModern(voice) {
        /* Current contract: engine in a header, voice as reference_id, and no
           instruction/emotion fields — the model does the delivery. */
        var body = {
          text: text,
          format: (tts.format === 'mp3') ? 'mp3' : 'wav'
        };
        if (voice) body.reference_id = voice;
        var model = String(tts.fishModel || '').trim() || FISH_MODERN_DEFAULT_MODEL;
        return requestAudio(localProxy(fishTtsUrl(tts.fishBaseUrl)), body, tts.fishApiKey, 180000,
                            { model: model },
                            function (st, raw, key) { return fishErrorMessage(st, raw, key, 'tts', root); });
      }

      function synthLegacy(voice) {
        var model = String(tts.fishModel || '').trim() || FISH_LEGACY_DEFAULT_MODEL;
        var lg = lang || (window.Langs ? Langs.tts() : 'ja');
        var body = {
          text: text,
          voiceId: voice,
          reference_id: voice,
          modelId: model,
          format: (tts.format === 'mp3') ? 'mp3' : 'wav'
        };
        var fishLang = fishLanguage(lg);
        if (fishLang) body.language = fishLang;
        if (fishWantsInstruction(model)) {
          var styleHint = ttsStyleFor(mode || 'chat', tts);
          if (styleHint) body.instruction = styleHint;
        }
        if (fishWantsEmotion(model)) {
          var emo = fishEmotion(emotion);
          if (emo) body.emotion = emo;
        }
        return requestAudio(localProxy(fishTtsUrl(tts.fishBaseUrl)), body, tts.fishApiKey, 180000,
                            null,
                            function (st, raw, key) { return fishErrorMessage(st, raw, key, 'tts', root); });
      }

      var synth = style === 'modern' ? synthModern : synthLegacy;
      var voice = fishVoiceFor(tts, mode);
      if (voice) return synth(voice);

      /* Empty voice on the CURRENT API is a working configuration: POST
         /v1/tts with the free engine and no reference_id answers with audio
         (measured live, 2026-09-21), Fish picks a default voice. Refusing here
         — which is what this used to do — made "paste the key, leave the rest
         blank" impossible on the very surface we recommend. */
      if (style === 'modern') return synth('');

      /* Auto-clone uploads local samples through the older Open API. */
      /* The clone runs first, so the voice id has to be read again afterwards:
         the resolved id lives in Config now, not in the snapshot above. */
      function synthAfterClone() {
        var now = {};
        try { now = Config.section('tts'); } catch (e) { now = tts; }
        return synth(fishVoiceFor(now, mode));
      }
      if (_fishCloneWait) return _fishCloneWait.then(synthAfterClone);
      _fishCloneWait = Api.fishCloneVoice().then(function (vid) {
        try { Config.set('tts.fishVoice', vid); } catch (e) {}
        _fishCloneWait = null;
        return vid;
      }, function (err) {
        _fishCloneWait = null;
        throw err;
      });
      return _fishCloneWait.then(synthAfterClone);
    },

    listFishVoices: function () {
      var tts = Config.section('tts');
      if (!tts.fishApiKey) return Promise.reject(new Error('NO_KEY'));
      var root = fishApiRoot(tts.fishBaseUrl);
      /* Two shapes again: the older Open API lists /voices with voiceId, the
         current one lists /model with _id (verified: it answers publicly with
         {items:[{_id,title,languages,…}]}). Both end up as {id,title}. */
      var modern = fishApiStyle(root) === 'modern';
      var url = modern
        ? root + '/model?page_size=100&page_number=1'
        : root + '/voices?pageSize=100&includePersonal=true';
      return requestGet(localProxy(url), tts.fishApiKey, 20000,
                       function (st, raw, key) { return fishErrorMessage(st, raw, key, 'voices', root); })
        .then(function (j) {
          var items = (j && j.items) || [];
          var out = [], seen = {};
          items.forEach(function (it) {
            if (!it) return;
            var id = it.voiceId || it.voice_id || it.id || it._id;
            if (!id || seen[id]) return;
            seen[id] = 1;
            out.push({ id: id, title: it.title || it.name || id });
          });
          return out;
        });
    },

    fishCloneVoice: function () {
      var tts = Config.section('tts');
      if (!tts.fishApiKey) return Promise.reject(new Error('NO_KEY'));
      /* The current API builds a voice from /file + /model and needs the account
         to own it; uploading local samples is only the older Open API's move.
         Refusing with the next step beats a 404 from a path that does not exist
         there. */
      if (fishApiStyle(fishApiRoot(tts.fishBaseUrl)) === 'modern') {
        return Promise.reject(new Error(
          'Fish Audio（api.fish.audio）不支持本地样本自动克隆——请在 fish.audio 里创建音色，把它的 id 填到「Fish 音色」'));
      }
      return Promise.all(fishSampleUrls().map(function (url) {
        return fetch(url).then(function (r) {
          if (!r.ok) return null;
          return r.blob().then(function (blob) {
            if (!blob || !blob.size) return null;
            return { blob: blob, name: url.split('/').pop() || 'sample.wav' };
          });
        }).catch(function () { return null; });
      })).then(function (parts) {
        var files = parts.filter(Boolean);
        var wavs = files.filter(function (f) { return /\.wav$/i.test(f.name); });
        if (wavs.length) files = wavs;
        if (!files.length) {
          throw new Error('找不到本地莱莎原声（需要 assets/audio/prologue/jp/*.m4a 或 voice/ryza_wav/*.wav）');
        }
        var fd = new FormData();
        fd.append('name', 'ryza');
        fd.append('description', 'Local Ryza prologue clone');
        fd.append('visibility', 'private');
        fd.append('languages', JSON.stringify(['ja', 'zh', 'en']));
        files.forEach(function (f) { fd.append('audioFiles', f.blob, f.name); });
        return requestForm(localProxy(fishApiRoot(tts.fishBaseUrl) + '/voices'),
                           fd, tts.fishApiKey, 180000,
                           function (st, raw, key) {
                             return fishErrorMessage(st, raw, key, 'clone', fishApiRoot(tts.fishBaseUrl));
                           });
      }).then(function (j) {
        var vid = j && (j.voiceId || j.voice_id);
        if (!vid) throw new Error(apiErrorMessage(j, 200, '') || '未返回 voiceId');
        return vid;
      });
    },

    /* 声音复刻: register the shipped Ryza reference wav (data URI — the
       endpoint accepts base64 data URIs, no public hosting needed) and
       return the voice_id. target_model must match the synthesis model. */
    qwenCloneVoice: function () {
      var tts = Config.section('tts');
      if (!tts.qwenApiKey) return Promise.reject(new Error('NO_KEY'));
      var target = String(tts.qwenCloneTarget || 'qwen3-tts-vc-2026-01-22').trim();
      return Api._fetchAsDataUrl(tts.reference).then(function (dataUri) {
        return request(localProxy(qwenTtsUrl(tts.qwenBaseUrl, 'voice-enrollment')), {
          model: 'voice-enrollment',
          input: {
            action: 'create_voice',
            target_model: target,
            prefix: 'ryza',
            preferred_name: 'ryza',
            url: dataUri
          }
        }, tts.qwenApiKey, 120000);
      }).then(function (j) {
        var out = j && j.output;
        var vid = out && (out.voice_id || out.voice);
        if (!vid) throw new Error(apiErrorMessage(j, 200, '') || '未返回 voice_id');
        return vid;
      });
    },

    _b64ToUrl: function (b64, mime) {
      var bin = atob(b64), arr = new Uint8Array(bin.length), i;
      for (i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([arr], { type: mime }));
    },

    /* Reference audio must reach the API as `data:audio/wav;base64,...`. */
    _fetchAsDataUrl: function (path) {
      return fetch(path).then(function (r) {
        if (!r.ok) throw new Error('无法读取参考音频：' + path);
        return r.arrayBuffer();
      }).then(function (buf) {
        var bytes = new Uint8Array(buf), s = '', i;
        for (i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return 'data:audio/wav;base64,' + btoa(s);
      });
    }
  };

  global.Api = Api;
})(window);
