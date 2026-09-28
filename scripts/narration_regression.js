/* Narration vs speech: the prompt (api.js WRITING) asks the model to put
   narration on its own lines wrapped in （ ）, and npc.js must classify those
   lines as `narrator` beats — shown in italics, never voiced. Runs headless. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WEB = path.join(__dirname, '..', 'web');
let failures = 0;
const ok = (c, name) => { if (c) console.log('  PASS ' + name); else { failures++; console.log('  FAIL ' + name); } };

const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['util.js', 'npc.js']) {
  vm.runInContext(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'), sandbox, { filename: f });
}
const Npc = sandbox.Npc;

const reply = [
  '（工房の窓から朝の光が差し込み、ライザは釜の前で伸びをした。）',
  'おはよう！今日は何して遊ぶ？',
  '(She grins and taps the cauldron.)',
  '*a gull cries over the harbour*',
  'あ、そうだ、クーケン島に行くなら船がいるよね……。',
  'narrator: The tide is going out.',
  '(sigh) that boat is still broken though.'
].join('\n');

const beats = Npc.split(reply);
const kinds = beats.map((b) => b.speaker);
ok(kinds.join(',') === 'narrator,ryza,narrator,narrator,ryza,narrator,ryza',
   'full-width / ascii parentheses, *…* and the narrator: prefix are narration; plain lines are hers (' + kinds.join(',') + ')');
ok(beats[0].text === '工房の窓から朝の光が差し込み、ライザは釜の前で伸びをした。',
   'the wrapping brackets are stripped from a narration beat');
ok(beats[3].text === 'a gull cries over the harbour', 'the asterisks are stripped too');
ok(beats[6].text === '(sigh) that boat is still broken though.',
   'a line that only contains a parenthesis is still speech');

const spoken = Npc.spokenText(beats);
ok(spoken.indexOf('朝の光') === -1 && spoken.indexOf('gull') === -1,
   'narration never reaches the synthesizer');
ok(spoken.indexOf('おはよう') === 0 && spoken.indexOf('船がいる') !== -1,
   'her lines are what gets spoken, in order');

console.log(failures ? 'NARRATION: ' + failures + ' FAILURES' : 'NARRATION: OK');
process.exit(failures ? 1 : 0);
