'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadProfile, listSources, saveLayout, listActions, verifyLayout, applyNextLaunch } = require('./profile.cjs');
const { getActiveFileState, restoreActiveFile } = require('./active-files.cjs');
const { readXml } = require('./xml.cjs');

async function fixture(t) {
  const livePath = await fs.mkdtemp(path.join(os.tmpdir(), 'hotas-uplink-test-'));
  t.after(() => fs.rm(livePath, { recursive: true, force: true }));
  async function put(rel, text) {
    const file = path.join(livePath, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  }
  const game = `<profile>
    <actionmap name="flight" UILabel="@flight">
      <action name="pitch" joystick="y" UILabel="@pitch"/>
      <action name="landing" joystick="button1" activationMode="tap" UILabel="@land"/>
      <action name="clear" joystick="button2"/>
      <action name="multiple" joystick="button3"/>
    </actionmap>
    <actionmap name="turret"><action name="landing" joystick="button1"/></actionmap>
  </profile>`;
  await put('Data/Libs/Config/defaultProfile.xml', game);
  await put('Data/Localization/english/global.ini', 'flight=Flight\npitch=Pitch\nland=Request landing');
  return { livePath, put };
}

test('preview, apply, reopen and restore a saved layout with swapped joystick slots', async t => {
  const { livePath, put } = await fixture(t);
  const closed = async () => {};
  const options = (left, right) =>
    '<options type="joystick" instance="' + left + '" Product="VKB Gladiator L"/>' +
    '<options type="joystick" instance="' + right + '" Product="VKB Gladiator R"/>';
  const before = '<?xml version="1.0"?>\r\n<ActionMaps><ActionProfiles version="1" profileName="default">' +
    options(2, 1) + '<actionmap name="flight"><action name="landing"><rebind input="kb1_l"/>' +
    '<rebind input="js1_button8"/></action></actionmap></ActionProfiles></ActionMaps>\r\n';
  const active = await put('user/client/0/Profiles/default/actionmaps.xml', before);
  const saved = '<ActionMaps version="1" profileName="Test">' + options(1, 2) +
    '<actionmap name="flight"><action name="landing"><rebind input="js1_button9"/></action>' +
    '<action name="legacy"><rebind input="js1_button3"/><rebind input="js2_button7"/></action></actionmap></ActionMaps>';
  const profilePath = await put('user/client/0/Controls/Mappings/layout_test_exported.xml', saved);
  const preview = await loadProfile({ livePath, profilePath });
  const status = await getActiveFileState(livePath, closed);
  const request = { livePath, profilePath, expectedRevision: preview.source.revision, expectedActiveRevision: status.activeRevision };
  assert.ok(status.canApply, status.reason);
  assert.equal(await fs.readFile(active, 'utf8'), before);
  await fs.appendFile(profilePath, '\n');
  await assert.rejects(applyNextLaunch(request, closed), /changed/i);
  assert.equal(await fs.readFile(active, 'utf8'), before);
  await fs.writeFile(profilePath, saved);
  const applied = await applyNextLaunch(request, closed);
  assert.ok(applied.changed);
  assert.equal(applied.unlistedActionCount, 1);
  const reopened = await loadProfile({ livePath });
  assert.equal(reopened.source.name, 'default');
  assert.deepEqual(reopened.bindings.filter(b => b.context === 'flight' && b.action === 'landing')
    .map(b => [b.device, b.slot, b.input]), [['left', 2, 'button9']]);
  assert.match(await fs.readFile(active, 'utf8'), /input="kb1_l"/);
  assert.equal(await fs.readFile(applied.backup.path, 'utf8'), before);
  const again = await applyNextLaunch({ ...request, expectedActiveRevision: reopened.source.revision }, closed);
  assert.equal(again.changed, false);
  const undo = await getActiveFileState(livePath, closed);
  assert.equal(undo.backup.id, applied.backup.id);
  await restoreActiveFile({ livePath, expectedActiveRevision: undo.activeRevision, backupId: undo.backup.id }, closed);
  assert.equal(await fs.readFile(active, 'utf8'), before);
  assert.equal(await fs.readFile(profilePath, 'utf8'), saved);
});

test('profile inherits per action/device type, honors blank joystick overrides, gestures and context', async t => {
  const { livePath, put } = await fixture(t);
  const name = 'user/client/0/Profiles/default/actionmaps.xml';
  const explicit = `<ActionMaps><ActionProfiles profileName="current">
    <options type="joystick" instance="2" Product="VKBsim Gladiator EVO OT L SEM"/>
    <options type="joystick" instance="1" Product="VKBsim Gladiator EVO R"/>
    <actionmap name="flight">
      <action name="pitch"><rebind input="kb1_k"/></action>
      <action name="clear"><rebind input="js2_ "/></action>
      <action name="landing"><rebind input="js2_button57" multiTap="2"/></action>
      <action name="multiple"><rebind input="js1_button6"/><rebind input="js2_button6"/></action>
    </actionmap></ActionProfiles></ActionMaps>`;
  const file = await put(name, explicit);
  const { devices, bindings, source } = await loadProfile({ livePath });
  assert.equal(source.kind, 'active');
  assert.equal(devices.find(d => d.slot === 2).device, 'left');
  assert.equal(bindings.find(b => b.action === 'pitch').origin, 'default');
  assert.equal(bindings.find(b => b.action === 'pitch').device, 'right');
  assert.ok(!bindings.some(b => b.action === 'clear'));
  const landing = bindings.find(b => b.action === 'landing' && b.context === 'flight');
  assert.deepEqual([landing.label, landing.gesture, landing.input, landing.contextLabel],
    ['Request landing', 'Double tap', 'button57', 'Flight']);
  assert.equal(bindings.find(b => b.action === 'landing' && b.context === 'turret').input, 'button1');
  assert.equal(bindings.filter(b => b.action === 'multiple').length, 2);
  assert.equal(await fs.readFile(file, 'utf8'), explicit);
});

test('no active layout starts blank and an export supplies its own device identities', async t => {
  const { livePath, put } = await fixture(t);
  const absent = path.join(livePath, 'missing-install');
  assert.equal((await loadProfile({ livePath: absent })).source.missing, 'game-data');
  await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
  const blank = await loadProfile({ livePath });
  assert.equal(blank.source.kind, 'blank');
  assert.equal(blank.source.missing, 'active-profile');
  assert.equal(blank.bindings.length, 0);
  const exportXml = `<ActionMaps profileName="old">
    <options type="joystick" instance="1" Product="VKBsim Gladiator EVO OT L SEM"/>
    <actionmap name="flight"><action name="landing"><rebind input="js2_button4"/></action></actionmap>
  </ActionMaps>`;
  const filename = await put('user/client/0/Controls/Mappings/layout_old_exported.xml', exportXml);
  const entries = await listSources(livePath);
  assert.deepEqual(entries.map(e => e.path), [filename]);
  const snapshot = await loadProfile({ livePath, profilePath: filename });
  assert.equal(snapshot.source.kind, 'export');
  assert.equal(snapshot.source.missing, undefined);
  assert.equal(snapshot.bindings.find(b => b.action === 'pitch').device, 'left');
  assert.equal(snapshot.bindings.find(b => b.input === 'button4').device, 'unknown');
  assert.ok(snapshot.diagnostics.some(line => line.includes('Named export')));
  assert.ok(snapshot.diagnostics.some(line => line.includes('Unidentified')));
});

test('a transient archive read failure recovers on request and successful reads stay cached', async t => {
  const { livePath, put } = await fixture(t);
  const emptyZip = Buffer.alloc(22);
  emptyZip.writeUInt32LE(0x06054b50);
  const archive = await put('Data.p4k', emptyZip);
  await put('user/client/0/Profiles/default/actionmaps.xml', '<ActionMaps profileName="test"/>');

  const realOpen = fs.open;
  let opens = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === archive && ++opens === 1) {
      throw Object.assign(new Error('Fixture archive is busy'), { code: 'EBUSY' });
    }
    return realOpen(file, ...args);
  });

  const first = await loadProfile({ livePath });
  assert.ok(first.diagnostics.some(detail => detail.includes('Fixture archive is busy')));
  assert.equal(opens, 1);

  const [next, simultaneous] = await Promise.all([loadProfile({ livePath }), loadProfile({ livePath })]);
  for (const profile of [next, simultaneous]) {
    assert.ok(!profile.diagnostics.some(detail => detail.includes('archive')));
  }
  await listActions({ livePath });
  assert.equal(opens, 2);
});

test('named exports preserve other controls, metadata, modifiers, comments, alternatives and sources', async t => {
  const { livePath, put } = await fixture(t);
  const content = `<?xml version="1.0"?>
<ActionMaps version="1" optionsVersion="2" rebindVersion="2" profileName="Before">
 <CustomisationUIHeader label="Before" description="Keep &amp; decode" image="image"><devices/><categories/></CustomisationUIHeader>
 <options type="joystick" instance="1" Product="VKBsim Gladiator EVO R"/>
 <options type="joystick" instance="2" Product="VKBsim Gladiator EVO OT L SEM"><axis invert="1"/></options>
 <modifiers><mod input="kb1_lshift"/></modifiers>
 <!-- preserved comment -->
 <extra ignored="yes"><![CDATA[4 < 8]]></extra>
 <actionmap name="flight"><action name="landing">
   <rebind input="js2_button5" multiTap="2" activationMode="hold" extension="keep"/>
   <rebind input="js1_lshift+button10" activationMode="tap"/>
   <rebind input="kb1_k"/>
 </action></actionmap>
</ActionMaps>`;
  const file = await put('user/client/0/Controls/Mappings/layout_before_exported.xml', content);
  const before = await loadProfile({ livePath, profilePath: file });
  const result = await saveLayout({ livePath, profilePath: file, expectedRevision: before.source.revision, name: 'After', edits: [
    { context: 'flight', action: 'landing', previous: { slot: 2, input: 'button5', multiTap: 2 }, slot: 1,
      device: 'right', input: 'slider1', physicalDevice: 'sem', physicalKey: 'flaps-axis' },
    { context: 'flight', action: 'pitch', slot: 2, device: 'left', input: 'roty', mode: 'add' }
  ] });
  assert.equal(await fs.readFile(file, 'utf8'), content);
  const xml = await fs.readFile(result.path, 'utf8');
  for (const piece of ['<modifiers><mod input="kb1_lshift"/></modifiers>', '<axis invert="1"/>',
    '<extra ignored="yes"><![CDATA[4 < 8]]></extra>', '<!-- preserved comment -->',
    '<rebind input="kb1_k"/>', '<rebind input="js1_lshift+button10" activationMode="tap"/>']) assert.ok(xml.includes(piece));
  assert.equal(readXml(Buffer.from(xml)).tag, 'ActionMaps');
  const after = await loadProfile({ livePath, profilePath: result.path });
  const moved = after.bindings.find(b => b.input === 'slider1');
  assert.deepEqual([moved.physicalDevice, moved.physicalKey, moved.device, moved.activationMode, moved.multiTap], ['sem', 'flaps-axis', 'right', 'hold', 2]);
  assert.ok(xml.includes('extension="keep"'));
  assert.deepEqual(after.bindings.filter(b => b.action === 'pitch').map(b => b.input), ['y', 'roty']);
  assert.equal(after.bindings.filter(b => b.input === 'lshift+button10').length, 1);
  assert.equal(after.bindings.find(b => b.context === 'turret').origin, 'default');
  const cloned = await saveLayout({ livePath, profilePath: result.path, name: 'Another', edits: [] });
  assert.equal((await loadProfile({ livePath, profilePath: cloned.path })).bindings.find(b => b.input === 'slider1').physicalKey, 'flaps-axis');

  await assert.rejects(saveLayout({ livePath, profilePath: file, name: 'After', edits: [] }), /already exists/);
  assert.equal(await fs.readFile(result.path, 'utf8'), xml);
  await assert.rejects(saveLayout({ livePath, profilePath: file, name: 'Bad', expectedRevision: 'outdated' }), /changed on disk/);
  await assert.rejects(saveLayout({ livePath, profilePath: file, name: '../bad' }), /layout name/);
  await assert.rejects(saveLayout({ livePath, profilePath: file, name: 'Ambiguous', edits: [
    { context:'flight', action:'landing', slot:1, input:'button17' }
  ] }), /which existing/);
});

test('active wrapper converts to portable mapping, clearing one alternative preserves its siblings', async t => {
  const { livePath, put } = await fixture(t);
  const file = await put('user/client/0/Profiles/default/actionmaps.xml', `<ActionMaps><ActionProfiles profileName="default" rebindVersion="2">
    <options type="joystick" instance="1" Product="VKBsim Gladiator EVO R"/>
    <actionmap name="flight"><action name="landing"><rebind input="js1_button3"/><rebind input="js1_button4"/><rebind input="mo1_mouse1"/></action></actionmap>
  </ActionProfiles></ActionMaps>`);
  const original = await fs.readFile(file, 'utf8');
  const result = await saveLayout({ livePath, name: 'Cleared', edits: [
    { context: 'flight', action: 'landing', slot:1, input:null, previous: { slot:1, input:'button3' } },
    { context: 'flight', action: 'pitch', slot:1, input:null, previous: { slot:1, input:'y' } }
  ] });
  const xml = await fs.readFile(result.path, 'utf8');
  assert.equal(xml.includes('ActionProfiles'), false);
  assert.ok(xml.includes('<CustomisationUIHeader') && xml.includes('<mouse instance="1"'));
  assert.ok(xml.includes('mo1_mouse1') && xml.includes('js1_ "'));
  const reopened = await loadProfile({ livePath, profilePath: result.path });
  assert.deepEqual(reopened.bindings.filter(b=>b.context === 'flight' && b.action === 'landing').map(b=>b.input), ['button4']);
  assert.ok(!reopened.bindings.some(b => b.action === 'pitch'));
  assert.equal(await fs.readFile(file,'utf8'), original);
});

test('blank layout persists confirmed roles without inventing hardware and suppresses inherited joystick defaults', async t => {
  const { livePath } = await fixture(t);
  const catalog = await listActions({ livePath });
  assert.ok(catalog.some(a => a.context === 'flight' && a.action === 'landing' && a.label === 'Request landing'));
  const empty = await saveLayout({ livePath, blank: true, name:'Empty' });
  assert.deepEqual((await loadProfile({ livePath, profilePath: empty.path })).bindings, []);
  const added = await saveLayout({ livePath, blank: true, name:'First layout', edits:[
    { context:'flight', action:'landing', slot:2, device:'left', input:'button12' }
  ] });
  const view = await loadProfile({ livePath, profilePath: added.path });
  assert.equal(view.bindings.length, 1);
  assert.equal(view.bindings[0].device, 'left');
  assert.equal(view.devices.find(d => d.slot === 2).product, '');
});

test('a full draft registry passes through unknown products and legacy slots while validating new declarations', async t => {
  const { livePath, put } = await fixture(t);
  const file = await put('user/client/0/Controls/Mappings/layout_extra_exported.xml', `<ActionMaps profileName="extra">
   <options type="joystick" instance="1" Product="VKBsim Gladiator EVO R"/>
   <options type="joystick" instance="9" Product="Legacy input panel"><axis invert="1"/></options>
   <actionmap name="flight">
    <action name="landing"><rebind input="js9_button15"/></action>
    <action name="multiple"><rebind input="js12_button18"/></action>
   </actionmap></ActionMaps>`);
  const { devices } = await loadProfile({ livePath, profilePath: file });
  assert.deepEqual(devices.filter(d => d.device === 'unknown').map(d => [d.slot, d.product]), [[9, 'Legacy input panel'], [12, '']]);
  const draft = { livePath, profilePath: file, devices, edits: [
    { context: 'flight', action: 'pitch', slot:1, device:'right', input:'z' }
  ] };
  const copy = await saveLayout({ ...draft, name:'Keep other hardware' });
  const loaded = await loadProfile({ livePath, profilePath: copy.path });
  assert.deepEqual(loaded.devices, devices);
  assert.deepEqual(loaded.bindings.filter(b => b.slot > 8).map(b => [b.slot, b.input]), [[9, 'button15'], [12, 'button18']]);
  const bad = name => ({ ...draft, name:'Reject change', devices:[...devices, name] });
  await assert.rejects(saveLayout(bad({ slot:12, device:'left', product:'' })), /slot/);
  await assert.rejects(saveLayout(bad({ slot:2, device:'unknown', product:'New panel' })), /slot/);
  await assert.rejects(saveLayout(bad({ slot:1, device:'right', product:'Unrelated joystick' })), /different joystick product/);
});

test('post-export check rereads the active file and distinguishes edits, gestures, and context', async t => {
  const { livePath, put } = await fixture(t);
  const activePath = 'user/client/0/Profiles/default/actionmaps.xml';
  const xml = button => `<ActionMaps><ActionProfiles profileName="default">
    <options type="joystick" instance="1" Product="VKBsim Gladiator EVO R"/>
    <actionmap name="flight"><action name="landing"><rebind input="js1_button${button}" multiTap="2"/></action></actionmap>
    </ActionProfiles></ActionMaps>`;
  const active = await put(activePath, xml(4));
  const saved = await saveLayout({ livePath, name:'Updated', edits:[
    { context:'flight', action:'landing', previous:{slot:1,input:'button4'}, slot:1, input:'button5' }
  ] });
  const verify = () => verifyLayout({ livePath, profilePath:saved.path, expectedRevision:saved.revision });
  const originalExport = await fs.readFile(saved.path, 'utf8');
  let result = await verify();
  assert.equal(result.status, 'different');
  assert.equal(result.differenceCount, 1);
  assert.equal(result.differences[0].context, 'flight');
  assert.equal(await fs.readFile(active, 'utf8'), xml(4));
  await put(activePath, xml(5));
  result = await verify();
  assert.equal(result.status, 'match');
  assert.equal(result.matchedCount, result.activeCount);
  assert.ok(result.activeModifiedAt && result.checkedAt);
  // Identical raw button codes are insufficient if the activation differs.
  await put(activePath, xml(5).replace('multiTap="2"', 'multiTap="1"'));
  assert.equal((await verify()).status, 'different');
  await put(activePath, xml(5).replace('name="flight"', 'name="turret"'));
  assert.equal((await verify()).status, 'different');
  await fs.writeFile(saved.path, originalExport + '\n');
  assert.equal((await verify()).status, 'inconclusive');
});

test('post-export verification reconciles known device reordering and declines ambiguous physical identity', async t => {
  const { livePath, put } = await fixture(t);
  const locations = ['user/client/0/Controls/Mappings/layout_dual_exported.xml', 'user/client/0/Profiles/default/actionmaps.xml'];
  const right = 'VKBsim Gladiator EVO R', left = 'VKBsim Gladiator EVO OT L SEM';
  const profile = (r, l, leftProduct = left, rightProduct = right) => `<ActionMaps profileName="example">
    <options type="joystick" instance="${r}" Product="${rightProduct}"/>
    <options type="joystick" instance="${l}" Product="${leftProduct}"/>
    <actionmap name="flight">
      <action name="pitch"><rebind input="js${r}_y"/></action>
      <action name="clear"><rebind input="js${l}_ "/></action>
      <action name="multiple"><rebind input="js${l}_button11"/><rebind input="js${r}_button11"/></action>
      <action name="landing"><rebind input="js${l}_button42"/></action>
    </actionmap><actionmap name="turret"><action name="landing"><rebind input="js${r}_button1"/></action></actionmap>
    <modifiers><modifier input="js${r}_button14"/></modifiers></ActionMaps>`;
  const named = await put(locations[0], profile(1,2));
  const verify = () => verifyLayout({ livePath, profilePath:named });
  await put(locations[1], profile(2,1));
  assert.equal((await verify()).status, 'match');
  await put(locations[1], profile(2,1).replace('js1_button42', 'js2_button42'));
  assert.equal((await verify()).status, 'different');
  await put(locations[1], profile(2,1).replace('js2_button14', 'js2_button15'));
  assert.equal((await verify()).status, 'inconclusive');
  await put(locations[1], profile(2,1,'VKBsim Gladiator EVO OT L','VKBsim Gladiator EVO R SEM'));
  assert.equal((await verify()).status, 'inconclusive');
  await put(locations[1], profile(2,1).replace('<actionmap name="flight">', '<options type="joystick" instance="1" Product="Other controller"/><actionmap name="flight">'));
  assert.equal((await verify()).status, 'inconclusive');
  for (const unavailable of ['', right, 'Generic joystick']) {
    await put(locations[0], profile(1,2,unavailable));
    await put(locations[1], profile(1,2,unavailable));
    assert.equal((await verify()).status, 'inconclusive');
  }
});

test('absence, unreadable XML, or unavailable defaults cannot confirm a blank export', async t => {
  const { livePath, put } = await fixture(t);
  const empty = await saveLayout({ livePath, blank:true, name:'Empty check' });
  const verify = () => verifyLayout({ livePath, profilePath:empty.path, expectedRevision:empty.revision });
  assert.equal((await verify()).status, 'inconclusive');
  const active = 'user/client/0/Profiles/default/actionmaps.xml';
  await put(active, '<ActionMaps><ActionProfiles>');
  assert.equal((await verify()).status, 'inconclusive');
  await put(active, await fs.readFile(empty.path, 'utf8'));
  assert.equal((await verify()).status, 'match');
  await fs.unlink(path.join(livePath, 'Data/Libs/Config/defaultProfile.xml'));
  assert.equal((await verify()).status, 'inconclusive');
});
