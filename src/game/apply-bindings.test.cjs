'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readXml } = require('./xml.cjs');
const { readSemHint, semSignature } = require('./export.cjs');
const { mergeJoystickBindings } = require('./apply-bindings.cjs');

const xml = text => readXml(Buffer.from(text));
const registry = rows => new Map(rows.map(([slot, device, product]) =>
  [slot, { slot, device, product }]));
const saved = registry([[1, 'left', 'VKB L'], [2, 'right', 'VKB R'], [3, 'unknown', 'Pedals']]);
const live = registry([[1, 'right', 'VKB R'], [2, 'left', 'VKB L'], [4, 'unknown', 'Pedals']]);
const action = (name, body) => '<action name="' + name + '">' + body + '</action>';
const bind = (input, attrs = '') => '<rebind input="' + input + '"' + attrs + '/>';
const group = body => '<actionmap name="flight">' + body + '</actionmap>';
const map = body => '<ActionMaps version="1">' + body + '</ActionMaps>';
const declarations = devices => [...devices.values()].map(d =>
  '<options type="joystick" instance="' + d.slot + '" Product="' + d.product + '"/>').join('');
const defaultMap = entries => new Map(entries.map(([action, ...inputs]) => ['flight/' + action,
  { context: 'flight', action, defaults: inputs.map(input => ({ input })) }]));

function merge(active, preset, options = {}) {
  return mergeJoystickBindings({ activeRoot: xml(active), presetProfile: xml(preset),
    definitions: defaultMap([['known']]), activeDevices: live, presetDevices: saved, ...options });
}

function inputsFor(text, name) {
  let root = xml(text);
  root = root.children.find(n => n.tag === 'ActionProfiles') || root;
  const node = root.children.find(n => n.tag === 'actionmap').children.find(n => n.attrs.name === name);
  return node?.children.filter(n => n.tag === 'rebind').map(n => n.attrs.input) || [];
}

test('routes both hands across a reorder and retains the active wrapper, calibration, unrelated inputs, and modifiers', () => {
  const keep = '<options type="joystick" instance="1" Product="VKB R"><axis invert="1"/></options>';
  const active = '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n<ActionMaps><ActionProfiles profileName="default">' +
    keep + '<!-- keep note -->' + '<modifiers><mod input="kb1_lalt"/><mod input="js4_button7"/></modifiers>' +
    group(action('fire', bind('kb1_f') + bind('mo1_mouse1') + bind('gp1_x') + bind('js4_x') + bind('js2_button18'))) +
    '</ActionProfiles></ActionMaps>\r\n';
  const preset = map(declarations(saved) + '<options type="keyboard" instance="1"><axis invert="0"/></options>' +
    '<modifiers><mod input="js2_button5"/></modifiers>' + group(action('fire',
      bind('js1_button7', ' multiTap="2" activationMode="hold"') + bind('js2_button4', ' modifier="js3_button8"') +
      bind('js3_y') + bind('kb1_h'))));
  const result = merge(active, preset);
  assert.deepEqual(inputsFor(result, 'fire').sort(), ['kb1_f', 'mo1_mouse1', 'gp1_x', 'js4_x', 'js2_button7', 'js1_button4'].sort());
  for (const piece of [keep, '<!-- keep note -->', '<mod input="kb1_lalt"/>', '<mod input="js4_button7"/>',
    '<mod input="js1_button5"/>', 'modifier="js4_button8"', 'multiTap="2" activationMode="hold"',
    '<ActionProfiles profileName="default">']) assert.ok(result.includes(piece), piece);
  assert.ok(result.startsWith('\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n'));
  assert.ok(result.endsWith('</ActionMaps>\r\n'));
  assert.equal(merge(result, preset), result);
});

test('projected defaults follow the preset hand, explicit clears suppress defaults, and stale target actions are removed', () => {
  const definitions = defaultMap([['move', 'x'], ['fire', 'button4'], ['brake', 'js4_slider1']]);
  const active = map(declarations(live) + group(action('move', bind('js1_y')) + action('fire', bind('kb1_f')) +
    action('old', bind('js2_button12'))));
  const preset = map(declarations(saved) + group(action('fire', bind('js1_ ')) + action('brake', bind('js2_z'))));
  const result = merge(active, preset, { definitions });
  assert.deepEqual(inputsFor(result, 'move'), ['js2_x']);
  assert.deepEqual(inputsFor(result, 'fire').sort(), ['kb1_f', 'js2_ '].sort());
  assert.deepEqual(inputsFor(result, 'brake').sort(), ['js4_slider1', 'js1_z'].sort());
  assert.deepEqual(inputsFor(result, 'old'), []);
  assert.equal(merge(result, preset, { definitions }), result);
});

test('single-stick exports preserve other stick assignments even within the same action', () => {
  const onlyLeft = registry([[1, 'left', 'VKB L']]);
  const active = map(declarations(live) + group(action('fire', bind('js1_button2') + bind('js2_button3'))));
  const result = merge(active, map(declarations(onlyLeft) + group(action('fire', bind('js1_button9')))), { presetDevices: onlyLeft });
  assert.deepEqual(inputsFor(result, 'fire'), ['js1_button2', 'js2_button9']);
});

test('upgrades earlier signed SEM hints when a stick changes slot', () => {
  const attrs = { input: 'js1_button41', multiTap: '2' }, key = 'button41';
  const marker = '<!-- VKBTOOL SEM v1 ' + semSignature('flight', 'start', attrs, key) + ' ' + key + ' -->';
  const row = '<rebind input="js1_button41" multiTap="2">' + marker + '</rebind>';
  const result = merge(map(declarations(live)), map(declarations(saved) + group(action('start', row))));
  assert.match(result, /<!-- HOTAS UPLINK SEM v1 /);
  assert.doesNotMatch(result, /<!-- VKBTOOL SEM v1 /);
  const n = xml(result).children.find(n => n.tag === 'actionmap').children[0].children[0];
  assert.equal(n.attrs.input, 'js2_button41');
  assert.deepEqual(readSemHint('flight', 'start', n), { physicalDevice: 'sem', physicalKey: key });
});

test('carries older preset actions, keeps an unrelated legacy row, and handles keyboard modifiers separately', () => {
  const active = map(declarations(live) + group(action('legacy_pedals', bind('js4_rotx'))));
  const modifiers = '<modifiers><mod input="kb1_lshift"/></modifiers>';
  const preset = map(declarations(saved) + modifiers + group(action('legacy_target', bind('js1_button9'))));
  const result = merge(active, preset);
  assert.deepEqual(inputsFor(result, 'legacy_target'), ['js2_button9']);
  assert.deepEqual(inputsFor(result, 'legacy_pedals'), ['js4_rotx']);
  assert.ok(!result.includes('kb1_lshift'));
  const chord = preset.replace('js1_button9', 'js1_lshift+button9');
  assert.throws(() => merge(active, chord), /shared modifier/);
  const withModifier = active.replace('<actionmap', modifiers + '<actionmap');
  assert.deepEqual(inputsFor(merge(withModifier, chord), 'legacy_target'), ['js2_lshift+button9']);
});

test('refuses ambiguous routes, unidentified binding slots, and conflicting modifier changes', () => {
  const preset = map(declarations(saved) + group(action('fire', bind('js1_button3'))));
  const twoLeft = registry([[1, 'left', 'VKB Custom L'], [2, 'left', 'VKB Other L']]);
  assert.throws(() => merge(map(declarations(twoLeft)), preset, { activeDevices: twoLeft }), /uniquely match/);
  assert.throws(() => merge(map(declarations(live)), map(group(action('fire', bind('js6_button1'))))), /does not identify/);
  assert.throws(() => merge(map(declarations(live)), map(declarations(saved) + declarations(saved))), /slot declarations/);
  assert.throws(() => merge(map('<ActionProfiles/><ActionProfiles/>'), preset), /Multiple control profiles/);
  assert.throws(() => merge(map(declarations(live)), map(group(action('fire', '<addbind input="js1_button2"/>')))),
    /Unsupported joystick binding/);
  const shared = '<modifiers><mod input="js1_button5"/></modifiers>';
  assert.throws(() => merge(map(shared + group(action('brake', bind('js4_z', ' modifier="js1_button5"')))), preset),
    /Another device uses a joystick modifier/);
});

test('retains a standalone active profile prolog and comments and rejects unsupported encodings', () => {
  const active = '<?xml version="1.0"?>\n<!-- lead -->\n<ActionProfiles>' + declarations(live) +
    '</ActionProfiles>\n<!-- end -->';
  const preset = map(declarations(saved) + group(action('fire', bind('js1_button4'))));
  const result = merge(active, preset);
  assert.ok(result.startsWith('<?xml version="1.0"?>\n<!-- lead -->\n<ActionProfiles>'));
  assert.ok(result.endsWith('</ActionProfiles>\n<!-- end -->'));
  assert.throws(() => merge(active.replace('version="1.0"', 'version="1.0" encoding="UTF-16"'), preset), /encoding/);
});

test('rejects malformed active or preset attributes and accepts genuine text, comments, CDATA and entities', () => {
  for (const invalid of ['<ActionMaps x=unquoted/>', '<ActionMaps x="1" x="2"/>',
    '<ActionMaps x="ok" broken/>', '<ActionMaps x="&custom;"/>', '<ActionMaps x="&#0;"/>',
    'unexpected<ActionMaps/>', '<ActionMaps/>trailing', '<![CDATA[bad]]><ActionMaps/>']) {
    assert.throws(() => xml(invalid), /XML|CDATA/);
  }
  const opaque = '<extra n="&#x1f680;">&lt; &amp;<!-- kept --><![CDATA[< & >]]></extra>';
  const active = '<?xml version="1.0"?>' + map(declarations(live) + opaque);
  const preset = map(declarations(saved) + group(action('start', bind('js1_button1'))));
  assert.ok(merge(active, preset).includes(opaque));
});
