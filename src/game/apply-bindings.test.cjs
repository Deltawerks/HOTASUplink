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
const alternate = (input, attrs = '') => '<addbind input="' + input + '"' + attrs + '/>';
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
  return node?.children.filter(n => ['rebind', 'addbind'].includes(n.tag)).map(n => n.attrs.input) || [];
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

test('declared but unbound Falcon pedals and sticks of other families remain intact', () => {
  const devices = registry([[1, 'right', 'VKB R'], [2, 'right', 'RIGHT VPC Stick MT-50CM3'], [3, 'pedals', 'VPC R1-FALCON Pedals']]);
  const active = map(declarations(devices) + group(action('landing', bind('js1_button5') + alternate('js2_button6') + alternate('js3_z'))));
  const preset = map(declarations(devices) + group(action('landing', bind('js2_button7') + alternate('js1_button9'))));
  const options = { presetDevices: devices, activeDevices: devices, scope: { family: 'virpil', pedals: true } };
  assert.deepEqual(inputsFor(merge(active, preset, options), 'landing'), ['js1_button5', 'js3_z', 'js2_button7']);
});

test('applies both Request Landing buttons across a slot reorder and retains unrelated bindings and gestures', () => {
  const extraKey = alternate('kb1_n', ' activationMode="hold"');
  const active = map(declarations(live) + group(action('landing', bind('kb1_l') + extraKey + bind('js2_button8') + alternate('js4_button3'))));
  const preset = map(declarations(saved) + group(action('landing', bind('js2_button42') + alternate('js2_button47', ' multiTap="2"'))));
  const result = merge(active, preset);
  assert.deepEqual(inputsFor(result, 'landing'), ['kb1_l', 'kb1_n', 'js1_button42', 'js1_button47', 'js4_button3']);
  assert.ok(result.includes(bind('js1_button42')));
  assert.ok(result.includes(alternate('js1_button47', ' multiTap="2"')));
  assert.ok(result.includes(alternate('js4_button3')));
  assert.ok(result.includes(extraKey));
  assert.equal(merge(result, preset), result);
});

test('an additive-only preset keeps an inherited primary while an explicit blank removes it', () => {
  const definitions = defaultMap([['landing', 'button1']]);
  const active = map(declarations(live) + group(action('landing', bind('js1_button2') + alternate('js2_button3'))));
  const preset = map(declarations(saved) + group(action('landing', alternate('js1_button4'))));
  const result = merge(active, preset, { definitions });
  assert.deepEqual(inputsFor(result, 'landing'), ['js2_button1', 'js2_button4']);
  assert.ok(result.includes(bind('js2_button1')) && result.includes(alternate('js2_button4')));
  assert.equal(merge(result, preset, { definitions }), result);
  const cleared = preset.replace(alternate('js1_button4'), bind('js1_ ') + alternate('js1_button4'));
  const onlyAlternate = merge(active, cleared, { definitions });
  assert.deepEqual(inputsFor(onlyAlternate, 'landing'), ['js2_button4']);
  assert.ok(onlyAlternate.includes(bind('js2_button4')));
  assert.equal(merge(onlyAlternate, cleared, { definitions }), onlyAlternate);
});

test('untouched alternatives on other devices and multiple inherited defaults do not rewrite the active document', () => {
  const definitions = defaultMap([['landing', 'button1', 'button2']]);
  const legacyPedals = action('brake', bind('js4_x') + bind('js4_slider1'));
  const active = map(declarations(live) + group(legacyPedals));
  assert.equal(merge(active, map(declarations(live)), { definitions, presetDevices: live }), active);
});

test('partial-device apply promotes an unrelated remaining alternate and preserves modifiers referenced by keyboard alternates', () => {
  const onlyLeft = registry([[1, 'left', 'VKB L']]);
  const modifiers = '<modifiers><mod input="js2_button5"/></modifiers>';
  const active = map(declarations(live) + group(action('landing', bind('js2_button3') + alternate('js1_button2'))));
  const preset = map(declarations(onlyLeft) + group(action('landing', bind('js1_ '))));
  const result = merge(active, preset, { presetDevices: onlyLeft });
  assert.deepEqual(inputsFor(result, 'landing'), ['js1_button2']);
  assert.ok(result.includes(bind('js1_button2')));
  assert.equal(merge(result, preset, { presetDevices: onlyLeft }), result);
  const withModifier = map(declarations(live) + modifiers + group(action('landing',
    bind('kb1_l') + alternate('kb1_n', ' modifier="js2_button5"'))));
  assert.throws(() => merge(withModifier, preset, { presetDevices: onlyLeft }), /Another device uses a joystick modifier/);
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
  assert.throws(() => merge(map(declarations(live)), map(group(action('fire', '<unknown input="js1_button2"/>')))),
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
