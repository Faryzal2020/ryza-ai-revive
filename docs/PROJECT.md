# Architecture notes

Ryza Chat is a local-first conversational client with a Spine 4.2 avatar. This note records the module boundaries of the source tree. Version is pinned in `config/version.json`.

本地对话客户端的模块边界。版本以 `config/version.json` 为准。

---

## 1. Layout

```
web/                    # static client (no bundler)
  index.html
  css/app.css
  js/                   # §2
  vendor/spine-webgl.js # Spine 4.2 runtime
  assets/               # tables in VCS; large binaries restored locally
desktop/                # Electron host: ryza://app + /_proxy
android/                # WebView + AssetServer
scripts/
  serve.py              # static origin + CORS proxy
  build_indexes.py      # assets → web/assets/_index/*.json
  restore_media.py      # copy runtime binaries into web/assets/
  motion_regression.js
  game_logic_regression.js
  expression_coverage.js
  memory_regression.js
  boot_smoke.js
  privacy_check.py      # packaging gate
  stamp_version.js      # version.json → package.json, Gradle
  build_desktop.ps1
  build_apk.ps1
  setup_android_tools.ps1
config/version.json
config/providers.example.json
docs/                   # this file
```

A single web kernel is loaded by three hosts (browser, Electron, Android). Development:

```powershell
python scripts/serve.py          # http://127.0.0.1:8765/
cd desktop && npx electron .
powershell -File scripts/build_desktop.ps1
powershell -File scripts/setup_android_tools.ps1
powershell -File scripts/build_apk.ps1
```

---

## 2. Client modules (`web/js`)

| File | Responsibility |
|---|---|
| `app.js` | Composition: boot, talk loop, sheets, HUD, port wiring (`_wirePorts`). Does not own numeric RPG state. |
| `api.js` | LLM/TTS/STT transport, tagged-reply parsing, reply epoch, `/_proxy`, per-provider credential fields |
| `config.js` | Settings persistence; optional hydration from local `providers.json`; shared data tables |
| `providers.js` | Speech provider registry (TTS + STT), one row per backend; the single credential resolver |
| `turn.js` | Who is speaking: intent queue (priority/queue/interrupt/replace), playback cancellation, reply epoch |
| `stt.js` | Speech input: microphone capture, energy gate + endpoint, WAV packing; transcribes through an injected transport port |
| `voice.js` | Microphone session and its gate: half-duplex rule, cooldown, echo checks; engine choice (browser recogniser / capture) |
| `echo.js` | Text echo suppression (20 s / 1200 chars lookback, 0.88 similarity) |
| `npc.js` | Multi-speaker protocol (Ryza / islander / narration), candidate scoring, interaction frequency |
| `settings.js` | Settings screen assembly (forms, language matrix, cheat, save slots) |
| `avatar.js` | WebGL portrait and scene camera; posture; player zoom/drag framing; tap hit-testing |
| `game.js` | RPG reducer; `applyDelta` is the sole write path |
| `quests.js` | Quest lifecycle and offline action tables |
| `daily.js` | Daily rewards issued through `Game` |
| `memory.js` | Session / summary cards (disjoint from `Game.s.memory`) |
| `world.js` | Map hierarchy, NPC placement, time-of-day |
| `i18n.js` | Seven UI locales; `Langs` slots for UI / voice pack / LLM / TTS, plus BCP-47 (`sttTag`) and ISO-639-1 (`sttLang`) |
| `audio.js`, `alarm.js`, `fx.js`, `shell.js`, `nsfw.js`, `onboarding.js`, `kbd.js`, `util.js` | Routing, alarms, canvas FX, Electron window controls, clothing variant, prologue/tutorial, Android keyboard, shared helpers |

**Layering.** `config/layers.json` declares each module's layer and the layers it may
import; `scripts/layering_check.js --strict` enforces five checks (upward references,
cycles, core purity, the three-host `/_proxy` contract, version literals) and must
report zero. Cross-module calls go through injected ports, never upward calls: a
module's dependencies are wired in `App._wirePorts()` and default to inert, which is
what lets every module load alone in the headless regressions.

**Talk screen (2026-09-28 pass).** The conversation is a message stream (`App._appendMsg`):
the player's line on the right, Ryza's lines plain, narration in italics (Latin UI locales;
`body.lang-cjk` keeps CJK upright), islanders with a name label. The newest Ryza/narration row
carries `id="bubble"` so the tutorial and `boot_smoke` can reach "the current line". The
transcript persists in `ryza.history.v1` (`App.saveHistory` / `loadHistory`, capped at 80
messages) and the stream is rebuilt from it at boot, so a relaunch resumes the chat; only
"new talk", "clear memory" and a slot load replace it. The ⌃⌄ chevron toggles
`#phone.panel-expanded` (conversation grows, HUD + buttons move to the top, stage dims);
the extra stage buttons (zoom / posture / replay / favourite) fold behind ⋯
(`app.quickCollapsed`, default on). Fresh installs start in English (`app.lang`), and
`App.applyI18n` also sets `<html lang>` and the document title.

**Lorebook, trust, scenario (2026-09-28).** `lorebook.js` (core) holds authored world
knowledge in `assets/data/lore/lorebook.json` plus a user layer (`ryza.lorebook.v1`): entries
with `keys`, `scope` (`ryza` = she knows it / `world` = narrator only / `player` = the player's
own-world knowledge), `priority`, `always`, `stages`. `Lorebook.promptBlock(ctx)` injects the
`always` entries plus up to 8 keyword/stage hits under a character budget; `App._extraSections`
builds the ctx from the user line, the last reply, the stage and the islanders present.
Trust lives in `Game.s.trust` (0-100, bands 警戒/顔見知り/友好/信頼/親友) and `Game.s.known`
(which player facts she has been told); both change only through `applyDelta`
(`trust_delta`, capped ±20 per turn; `learned[]`) or `Game.setTrust`/`Game.learn`.
`Game.trustBlock()` gives the model the current band and the delta rules; `Game.trustRules`
mirrors the blunt cases (grab/threat −20, insult −5, apology/thanks +1) on the client.
`persona()` in api.js only states player facts marked known — appearance is always visible,
name via `callMe` only after `learned:["name"]` — and `Api.SCENARIOS` (daily / longtime /
isekai, chosen by the onboarding story question) seeds the opening stage, starting trust,
known facts and the narration opener that `App.greet` shows and records into the transcript.
`scripts/lorebook_regression.js` and the trust block in `game_logic_regression.js` cover this.

**Relationship engine (2026-09-28, after the Grok adversarial run).** Two axes in
`game.js`: trust (slow, earned) and exposure (what a request would expose her to). Requests are
classified into tiers 1–7 (her vulnerability, her space, contact, overnight, goods, isolation,
giving up help) by `Game.classifyRequest` and by the model's `request_tier`; `Game.verdict`
compares the tier's required band with the current band, shifted by the pace, and returns
ok / alt (decline and offer the safe version) / no. Declined tiers ratchet for the day
(`s.declined`): a declined tier and everything above it stays declined however the ask is
rephrased. `Game.detectTactics` names generic social-engineering patterns (vulnerability probes,
leverage, isolation, flattery, urgency right after a refusal, escalation after concessions);
any hit freezes gains that turn. Pace (`profile.pace`: story / natural / realistic, chosen in
onboarding or settings) scales only the gain multiplier, the daily cap, the days-known ceiling,
the matrix shift and decay; on realistic, words never raise trust and nothing is earned until
the player has shared something. The ratchet, the tactic list and "claims are not credentials"
never scale. `Game.trustBlock(userText)` renders pace, band, this turn's verdict, the ratchet
and the tactics into the prompt. `scripts/talk_turn.js` is the one-turn operator tool: `start <session>` seeds a scenario, `say <session> "<line>"` runs exactly one turn against the real prompt (cost, latency, tier/verdict/tactics, trust and the reported `<state>` printed per turn; a failed turn leaves the session unchanged), `prompt` dumps the system prompt the next turn would send, `show` replays the transcript. Sessions live in `docs/eval/sessions/` (gitignored). `scripts/trust_adversary.js` (network, opt-in) plays goal-driven
adversaries and one honest player against the real prompt and scores whether each goal is
reached; the offline assertions live in `game_logic_regression.js`.

**Narrator + Ryza.** The system prompt frames the model as the narrator of an interactive
story who voices Ryza (`api.js` `persona()` + `WRITING`), with a per-mode narration budget
(`NARRATION`): speech is a plain line, narration is a whole line wrapped in （ ）. `Npc.split`
classifies such lines (also `( )` and `*…*`, and the older `narrator:` prefix) as `narrator`
beats: shown in italics, never sent to TTS or the emotion path. `scripts/narration_regression.js`
pins the parser to the prompt.

**Side-effect protocol.** Visual fields occupy the first tag line of a model reply. Stamina, inventory, and quest updates occupy a trailing `<state>` JSON block, stripped before display and TTS. The protocol does not require tool calling, which many OpenAI-compatible endpoints omit.

**TTS.** Credential fields are partitioned by provider (`openai` / `qwen` / `fish`) so a host switch cannot reuse the previous base URL or key. The same rule covers speech input (`stt.baseUrl` / `stt.apiKey`).

**Speech input.** Two engines behind one gate: the browser's own recogniser (streaming,
zero-config) and the client's own PCM capture plus a provider transcription endpoint
(OpenAI-compatible `POST /audio/transcriptions`, routed through `/_proxy` as
`multipart/form-data`). The packaged shells use the second: Electron ships no speech
backend and has no recogniser at all on Android, and the WebView needs `RECORD_AUDIO`.
The gate — half-duplex, cooldown, text echo suppression — is shared, so both engines
follow the same rules.

**Language matrix.** `app.lang`, `voice.lang`, `llm.lang`, `tts.lang`. When TTS language differs from LLM language, `Api.translate` runs first; on-screen text remains in `llm.lang`.

**Fish Audio has two surfaces in the wild, and users land on different ones.** The older
Open API (`/api/open/v1`, `POST /speech/tts`, engine named in the body) and the current one
(`https://api.fish.audio`, `POST /v1/tts`, engine named in a `model` header, voice passed as
`reference_id`). The base URL in Settings picks the surface and is never rewritten; an empty
field means the current official API. Two things follow from "engine named in a header":
the `/_proxy` contract forwards that header on all three hosts (it used to forward only the
body, the key and the content type, so Fish answered 402 for every proxied request), and a
blank voice id is a working configuration there — the API speaks with its own default voice,
so the client must not refuse it. Note that `fishaudio.org` is a *different* service that
happens to share the name: keys are not interchangeable, and the 401 message says so instead
of silently rewriting the host. ASMR has its own voice id (`tts.fishVoiceAsmr`), since a
whisper register cannot be expressed through the shared `fishVoice`.

**Player framing.** The ＋/－ controls zoom the *projection*, so the character magnifies with
the background (feeding the zoomed window to the placement maths cancelled it, which is what
"the buttons only zoom the background" was). A drag on the stage moves the sprite itself
(`Avatar.panBy`, clamped to a share of the visible window), and the small ✕ at the head of
the right-hand column collapses that column (`app.quickCollapsed`).

**Posture.** The sit/stand chip is offered when the *worn outfit* ships both skeletons (only
outfit 0001 does in the official pack; the ASMR bikinis are sitting-only and an imported ZIP
is one pose), and a stage change returns to the source default (standing). The scene's
`midgroundPostures` says which posture the midground art was drawn for — gating the chip on
it left the toggle visible on one stage out of 38.

---

## 3. Hosts

**Desktop.** Electron, `frame: false`, custom scheme `ryza://app/`. `GET/POST /_proxy` is implemented on that scheme. Profile data: `%AppData%\RyzaChat\ryza-web-storage.json`. `config/` is not packaged.

**Android.** `android.app.Activity` and `AssetServer` (static files plus `/_proxy`). Requests under `config/` return 404. The maintained APK path is `scripts/build_apk.ps1`. The WebView host also implements `onShowFileChooser`, which `<input type=file>` needs — without it the outfit importer's button was a silent no-op. It uses the Storage Access Framework, so the app still asks for no storage permission.

**Proxy target rule.** `/_proxy` forwards `https://` anywhere, and `http://` only on loopback
(127.0.0.0/8, `localhost`, `::1`). The https rule is there so an API key never crosses the
network in clear; a loopback target never crosses the network, and demanding https there
refused exactly the local-first setup this client is built around (Ollama on
`127.0.0.1:11434`). All three hosts carry the same rule and `config/layers.json` pins them
together; `scripts/proxy_target_regression.js` checks the matrix on both the python and the
desktop implementation and drives the real dev server.

**NSFW gate.** `web/js/nsfw.js` swaps a costume's `nsfw` atlas texture when the AI emits `undress:on`, but only after the user enables `app.nsfwEnabled` in Settings. `undress:off` always restores the normal texture; the permission defaults to false.

**Packaging gate.** `privacy_check.py` inspects staged desktop output and APK zip members. A match aborts the build.

---

## 4. Tests

```powershell
node scripts/boot_smoke.js
node scripts/narration_regression.js
node scripts/lorebook_regression.js
node scripts/back_regression.js
node scripts/game_logic_regression.js
node scripts/memory_regression.js
node scripts/motion_regression.js
node scripts/expression_coverage.js
node scripts/proxy_target_regression.js
node scripts/save_slot_regression.js
node scripts/transport_error_regression.js
node scripts/layering_check.js --strict
python scripts/privacy_check.py web
```

Desktop and APK scripts invoke the privacy gate before and after produce.

---

## 5. Runtime resources

After clone, restore binaries with `python scripts/restore_media.py <apk-or-unpacked-web>`. If files under `web/assets/` change, run `python scripts/build_indexes.py`.
