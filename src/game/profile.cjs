'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { readGameAssets } = require('./archive.cjs');
const { readXml } = require('./xml.cjs');
const { writeLayout, readSemHint, readHostHint } = require('./export.cjs');
const { compareJoysticks } = require('./verify.cjs');
const { mergeJoystickBindings } = require('./apply-bindings.cjs');
const { applyActiveFile } = require('./active-files.cjs');

const defaultsName = 'data/libs/config/defaultprofile.xml';
const localeName = 'data/localization/english/global.ini';
const presets = {
  'builtin:gnx': { name: 'VKB Gladiator NXT Premium Dual', entry: 'data/libs/config/mappings/layout_vkb_gnx_prem_dual.xml' },
  'builtin:scg': { name: 'VKB Space Gunfighter SCG Premium Dual', entry: 'data/libs/config/mappings/layout_vkb_scg_prem_dual.xml' }
};
const activeRelative = path.join('user', 'client', '0', 'Profiles', 'default', 'actionmaps.xml');
let catalogCache = null;

function nodes(node, tag) {
  return node?.children.filter(child => child.tag === tag) || [];
}

async function optionalStat(filename) {
  try { return await fs.stat(filename); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

async function readLimited(filename, maxBytes) {
  const file = await fs.open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Unexpected data file size: ' + path.basename(filename));
    return await file.readFile();
  } finally { await file.close(); }
}

function locMap(bytes) {
  const labels = new Map();
  if (bytes) {
    for (const line of bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const split = line.indexOf('=');
      if (split > 0) labels.set(line.slice(0, split).toLowerCase(), line.slice(split + 1).trim());
    }
  }
  return labels;
}

function labelFor(value, fallback, labels) {
  if (!value) return fallback;
  if (!value.startsWith('@')) return value;
  return labels.get(value.slice(1).toLowerCase()) || fallback;
}

function humanName(name) {
  return name.replace(/^v_/, '').replace(/_/g, ' ').replace(/^./, first => first.toUpperCase());
}

function idFor(context, action) { return context + '/' + action; }

function collectDefinitions(root, labels) {
  const definitions = new Map();
  for (const group of nodes(root, 'actionmap')) {
    const context = group.attrs.name;
    for (const { attrs, children } of nodes(group, 'action')) {
      const action = attrs.name;
      const joy = children.find(child => child.tag === 'joystick');
      let defaults = [];
      if (joy) {
        if (joy.attrs.input) defaults.push(joy.attrs);
        defaults.push(...nodes(joy, 'inputdata').map(node => node.attrs));
      } else if (attrs.joystick) {
        defaults.push({ input: attrs.joystick });
      }
      definitions.set(idFor(context, action), {
        action, context, label: labelFor(attrs.UILabel, humanName(action), labels),
        contextLabel: labelFor(group.attrs.UILabel, humanName(context), labels),
        category: group.attrs.UICategory || '', description: labelFor(attrs.UIDescription, '', labels),
        supportsJoystick: !!joy || Object.hasOwn(attrs, 'joystick'),
        activationMode: joy?.attrs.activationMode || attrs.activationMode || '',
        multiTap: joy?.attrs.multiTap || attrs.multiTap || '', defaults
      });
    }
  }
  return definitions;
}

async function assembleCatalog(archive, loose, looseProfile) {
  const diagnostics = [];
  let retryOnRequest = false;
  function reportReadError(message, error) {
    diagnostics.push(message + error.message);
    // A file can be temporarily inaccessible without changing its size or mtime.
    // Format errors, by contrast, persist until the file itself changes.
    if (error.syscall || /^E[A-Z]+$/.test(error.code)) retryOnRequest = true;
  }
  const names = [defaultsName, ...Object.values(presets).map(preset => preset.entry)];
  if (!loose) names.push(localeName);
  let assets = new Map();
  if (archive) {
    try { assets = await readGameAssets(archive, names); }
    catch (error) { reportReadError('Installed game archive could not be read: ', error); }
  } else diagnostics.push('Installed game archive could not be read: Data.p4k is unavailable.');
  let locale = assets.get(localeName);
  if (loose) {
    try { locale = await readLimited(loose, 32 * 1024 * 1024); }
    catch (error) { reportReadError('Could not read English labels: ', error); }
  }
  const labels = locMap(locale);
  if (!labels.size) diagnostics.push('English action labels unavailable. Showing names derived from action IDs.');
  let definitions = new Map();
  try {
    const bytes = looseProfile ? await readLimited(looseProfile, 16 * 1024 * 1024) : assets.get(defaultsName);
    if (!bytes) throw new Error('defaultProfile.xml is unavailable.');
    const root = readXml(bytes);
    if (root.tag !== 'profile') throw new Error('Unknown default profile format.');
    definitions = collectDefinitions(root, labels);
  } catch (error) { reportReadError('Inherited joystick defaults unavailable: ', error); }
  const builtins = new Map();
  for (const [key, preset] of Object.entries(presets)) {
    if (!assets.has(preset.entry)) continue;
    try {
      const bytes = assets.get(preset.entry);
      if (readXml(bytes).tag !== 'ActionMaps') throw new Error('Unknown preset format.');
      builtins.set(key, { bytes, revision: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    catch (error) { diagnostics.push('Could not read ' + preset.name + ': ' + error.message); }
  }
  return { definitions, builtins, diagnostics, retryOnRequest };
}

async function catalogFor(livePath) {
  const archive = path.join(livePath, 'Data.p4k');
  const loose = path.join(livePath, 'Data', 'Localization', 'english', 'global.ini');
  const looseProfile = path.join(livePath, 'Data', 'Libs', 'Config', 'defaultProfile.xml');
  const stats = await Promise.all([archive, loose, looseProfile].map(optionalStat));
  const token = JSON.stringify([livePath, ...stats.map(s => s && [s.size, s.mtimeMs])]);
  if (catalogCache?.token !== token) {
    catalogCache = { token, promise: assembleCatalog(stats[0] && archive, stats[1] && loose, stats[2] && looseProfile)
      .then(catalog => ({ ...catalog, token, gameDataFound: Boolean(stats[0]?.isFile() || stats[2]?.isFile()) })) };
  }
  const entry = catalogCache;
  let catalog;
  try {
    catalog = await entry.promise;
    return catalog;
  } finally {
    if (catalogCache === entry && (!catalog || catalog.retryOnRequest)) catalogCache = null;
  }
}

function deviceRole(product, sourceKey) {
  if (!/VKB/i.test(product)) return 'unknown';
  const name = product.split('{')[0];
  if (/\b(LH?|left)\b/i.test(name)) return 'left';
  if (/\b(RH?|right)\b/i.test(name)) return 'right';
  // The stock SCG pair's right-hand member is unqualified, but its product ID
  // is explicit. Apply that knowledge only to this stock preset.
  if (sourceKey === 'builtin:scg' && /\{0126231d-/i.test(product)) return 'right';
  return 'unknown';
}

function readDevices(profile, sourceKey) {
  const devices = new Map();
  for (const opt of nodes(profile, 'options')) {
    if (opt.attrs.type !== 'joystick') continue;
    const slot = Number(opt.attrs.instance);
    if (Number.isInteger(slot) && slot > 0) {
      const product = opt.attrs.Product?.trim() || '';
      const hint = readHostHint(opt, slot);
      if (!product && !hint) continue;
      const role = deviceRole(product, sourceKey);
      devices.set(slot, { slot, device: role !== 'unknown' ? role : hint || 'unknown', product });
    }
  }
  return devices;
}

function makeBinding(def, devices, slot, input, attrs, origin) {
  const activationMode = attrs.activationMode || def.activationMode || '';
  const multiTap = Number(attrs.multiTap ?? def.multiTap) || 1;
  const gesture = multiTap > 1 ? (multiTap === 2 ? 'Double tap' : multiTap + ' taps') :
    activationMode.replace(/_/g, ' ').replace(/^./, char => char.toUpperCase());
  const binding = { device: devices.get(slot)?.device || 'unknown', slot, input, action: def.action,
    label: def.label, context: def.context, contextLabel: def.contextLabel, gesture, activationMode, multiTap, origin };
  const extra = Object.entries(attrs).filter(([key]) => !['input', 'activationMode', 'multiTap'].includes(key));
  if (extra.length) binding.inputAttributes = Object.fromEntries(extra);
  return binding;
}

function resolveBindings(profile, definitions, devices) {
  const rows = new Map();
  for (const [id, def] of definitions) {
    const binds = [];
    for (const attrs of def.defaults) {
      const value = (attrs.input || '').trim().toLowerCase();
      if (!value) continue;
      // A bare joystick default is Star Citizen's first joystick input.
      const match = /^js(\d+)_(.*)$/.exec(value);
      binds.push(makeBinding(def, devices, match ? Number(match[1]) : 1, match ? match[2] : value, attrs, 'default'));
    }
    if (binds.length) rows.set(id, binds);
  }
  for (const group of nodes(profile, 'actionmap')) {
    const context = group.attrs.name;
    for (const actionNode of nodes(group, 'action')) {
      const action = actionNode.attrs.name, id = idFor(context, action);
      const def = definitions.get(id) || { action, context, label: humanName(action), contextLabel: humanName(context) };
      const binds = [];
      let hasJoystickOverride = false;
      for (const bind of nodes(actionNode, 'rebind')) {
        const attrs = bind.attrs;
        const input = /^js(\d+)_(.*)$/i.exec(attrs.input || '');
        if (!input) continue;
        hasJoystickOverride = true;
        const control = input[2].trim().toLowerCase();
        if (control) {
          const binding = makeBinding(def, devices, Number(input[1]), control, attrs, 'profile');
          Object.assign(binding, readSemHint(context, action, bind));
          binds.push(binding);
        }
      }
      // A blank jsN_ entry explicitly clears the joystick control. Other device
      // types leave the action's inherited joystick input intact.
      if (hasJoystickOverride) rows.set(id, binds);
    }
  }
  return [...rows.values()].flat();
}

async function buildVersion(livePath) {
  try { return JSON.parse(await readLimited(path.join(livePath, 'build_manifest.id'), 128 * 1024)).Data?.Version || null; }
  catch { return null; }
}

/** List the active file, named exports and the verified VKB presets present in this installation. */
async function listSources(livePath) {
  livePath = path.resolve(livePath);
  const sources = [];
  const active = path.join(livePath, activeRelative);
  if ((await optionalStat(active))?.isFile()) sources.push({ kind: 'active', name: 'Active game profile', path: active });
  const mappingDir = path.join(livePath, 'user', 'client', '0', 'Controls', 'Mappings');
  if ((await optionalStat(mappingDir))?.isDirectory()) {
    const files = await fs.readdir(mappingDir, { withFileTypes: true });
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (file.isFile() && /\.xml$/i.test(file.name)) sources.push({ kind: 'export', name: file.name, path: path.join(mappingDir, file.name) });
    }
  }
  const catalog = await catalogFor(livePath);
  for (const key of catalog.builtins.keys()) sources.push({ kind: 'builtin', name: presets[key].name, path: key });
  return sources;
}

/** Resolve saved joystick bindings. All installation access is read-only. Paths are relative
 * to the selected LIVE directory unless absolute. Built-ins use tokens returned by listSources. */
async function readSource(livePath, profilePath, catalog) {
  livePath = path.resolve(livePath);
  const active = path.join(livePath, activeRelative);
  const isBuiltin = Object.hasOwn(presets, profilePath ?? '');
  const file = isBuiltin ? profilePath : path.resolve(livePath, profilePath || active);
  const kind = isBuiltin ? 'builtin' : path.relative(active, file) === '' ? 'active' : 'export';
  const source = { kind, path: file, livePath, build: await buildVersion(livePath), name: '', modifiedAt: null, revision: null };
  let root, profile;
  if (kind !== 'builtin') {
    const stat = await optionalStat(file);
    if (!stat && kind === 'active') return { source: { ...source, kind: 'blank', name: 'No active game profile' }, profile: null };
    if (!stat) throw new Error('The selected game profile no longer exists.');
    source.modifiedAt = stat.mtime.toISOString();
    const bytes = await readLimited(file, 16 * 1024 * 1024);
    source.revision = crypto.createHash('sha256').update(bytes).digest('hex');
    root = readXml(bytes);
    if (root.tag !== 'ActionMaps' && root.tag !== 'ActionProfiles') throw new Error('Expected a Star Citizen action mapping.');
    profile = nodes(root, 'ActionProfiles')[0] || root;
  }
  if (isBuiltin) {
    const packed = catalog.builtins.get(profilePath);
    if (!packed) throw new Error('This VKB starter preset is unavailable in the installed game data.');
    root = readXml(packed.bytes);
    profile = nodes(root, 'ActionProfiles')[0] || root;
    source.revision = packed.revision;
  }
  source.name = isBuiltin ? presets[profilePath].name : profile.attrs.profileName || path.basename(file);
  return { source, profile, root };
}

async function loadProfile({ livePath, profilePath }) {
  livePath = path.resolve(livePath);
  const catalog = await catalogFor(livePath);
  const { source, profile } = await readSource(livePath, profilePath, catalog);
  if (!profile) {
    const missing = catalog.gameDataFound ? 'active-profile' : 'game-data';
    return { source: { ...source, missing }, devices: [], bindings: [],
      diagnostics: [catalog.gameDataFound ? 'No saved active profile was found in this installation.'
        : 'No installed game data or active profile was found in the selected folder.'] };
  }
  const diagnostics = [...catalog.diagnostics];
  const { kind } = source;
  if (kind === 'export') diagnostics.push('Named export. Inherited controls and labels use the currently installed game build.');
  const { devices, bindings } = readRig(profile, profilePath, catalog.definitions);
  const unknown = [...devices.values()].filter(d => d.device === 'unknown');
  if (unknown.length) diagnostics.push('Unidentified saved joystick slots: ' + unknown.map(d => d.slot).join(', ') + '.');
  return { source, devices: [...devices.values()], bindings, diagnostics };
}

function readRig(profile, sourceKey, definitions) {
  const devices = readDevices(profile, sourceKey);
  const bindings = resolveBindings(profile, definitions, devices);
  for (const { slot } of bindings) {
    if (!devices.has(slot)) devices.set(slot, { slot, device: 'unknown', product: '' });
  }
  return { devices, bindings };
}

/** All actions in this installed build, including actions with no saved assignment. */
async function listActions({ livePath }) {
  const catalog = await catalogFor(path.resolve(livePath));
  if (!catalog.definitions.size) throw new Error('The installed action catalog is unavailable.');
  return [...catalog.definitions.values()].map(({ defaults, ...fields }) => ({
    ...fields, multiTap: Number(fields.multiTap) || 1
  })).sort((a, b) => a.label.localeCompare(b.label) || a.contextLabel.localeCompare(b.contextLabel));
}

/** Create one importable named export. The active source and all older exports are left intact. */
async function saveLayout(options) {
  const livePath = path.resolve(options.livePath);
  const catalog = await catalogFor(livePath);
  const { profile, source } = options.blank ? { profile: null, source: { kind: 'blank' } } :
    await readSource(livePath, options.profilePath, catalog);
  if (!options.blank && options.expectedRevision !== undefined && options.expectedRevision !== source.revision) {
    throw new Error('The source profile changed on disk. Reload it before saving.');
  }
  const registry = profile ? readRig(profile, source.path, catalog.definitions).devices : new Map();
  return writeLayout({ ...options, livePath, profile, catalog, deviceRole, registry });
}

/** Install this preview's joystick assignments into the existing active profile. */
async function applyNextLaunch({ livePath, profilePath, expectedRevision, expectedActiveRevision }, checkGameClosed) {
  livePath = path.resolve(livePath);
  const mappingDir = path.join(livePath, 'user/client/0/Controls/Mappings');
  if (!Object.hasOwn(presets, profilePath ?? '') &&
      !(typeof profilePath === 'string' && /\.xml$/i.test(profilePath) &&
        path.relative(mappingDir, path.dirname(path.resolve(livePath, profilePath))) === '')) {
    throw new Error('Choose a saved layout or a game preset to apply.');
  }
  const catalog = await catalogFor(livePath);
  if (!catalog.definitions.size) throw new Error('The installed joystick defaults are unavailable. Check the game installation.');
  const preset = await readSource(livePath, profilePath, catalog);
  const ensureCurrent = revision => {
    if (revision !== expectedRevision) throw new Error('The selected layout changed. Reload its preview before applying.');
  };
  ensureCurrent(preset.source.revision);
  const definitions = catalog.definitions;
  const { devices: presetDevices, bindings } = readRig(preset.profile, profilePath, definitions);
  const unlistedActions = new Set(bindings.filter(row => row.device === 'left' || row.device === 'right')
    .map(row => idFor(row.context, row.action)).filter(id => !definitions.has(id)));
  const result = await applyActiveFile({
    livePath, expectedActiveRevision,
    transform(bytes) {
      const activeRoot = readXml(bytes);
      const activeProfile = nodes(activeRoot, 'ActionProfiles')[0] || activeRoot;
      const activeDevices = readRig(activeProfile, undefined, definitions).devices;
      return mergeJoystickBindings({ activeRoot, presetProfile: preset.root, definitions, activeDevices, presetDevices });
    },
    async validateSource() {
      const latest = await catalogFor(livePath);
      if (latest.token !== catalog.token || !latest.definitions.size) {
        throw new Error('The installed game data changed. Reload the layout before applying.');
      }
      if (preset.source.kind === 'export') {
        const bytes = await readLimited(preset.source.path, 16 * 1024 * 1024);
        ensureCurrent(crypto.createHash('sha256').update(bytes).digest('hex'));
      } else ensureCurrent(latest.builtins.get(profilePath)?.revision);
    }
  }, checkGameClosed);
  return { ...result, unlistedActionCount: unlistedActions.size };
}

/** Compare the named export with a freshly read active profile in this installation.
 * A match describes joystick assignments persisted on disk, independent of running-game state. */
async function verifyLayout({ livePath, profilePath, expectedRevision }) {
  livePath = path.resolve(livePath);
  const result = { status: 'inconclusive', message: '', checkedAt: new Date().toISOString(), activeModifiedAt: null,
    exportedCount: null, activeCount: null, matchedCount: null, differenceCount: null, differences: [] };
  const unconfirmed = message => ({ ...result, message });
  try {
    const catalog = await catalogFor(livePath);
    if (!catalog.definitions.size) return unconfirmed('The installed game defaults are unavailable for comparison.');
    const saved = await readSource(livePath, profilePath, catalog);
    if (saved.source.kind !== 'export') return unconfirmed('Select a named XML export to check.');
    if (expectedRevision != null && expectedRevision !== saved.source.revision) {
      return unconfirmed('The named XML file has changed since the export was saved.');
    }
    const active = await readSource(livePath, undefined, catalog);
    if (!active.profile) return unconfirmed('No active game profile is available on disk in this installation.');
    result.activeModifiedAt = active.source.modifiedAt;
    if (!active.profile.attrs.version && !active.profile.attrs.profileName && !nodes(active.profile, 'actionmap').length) {
      return unconfirmed('The active file does not contain a recognizable game profile.');
    }
    const expectedRig = readRig(saved.profile, profilePath, catalog.definitions);
    const activeRig = readRig(active.profile, undefined, catalog.definitions);
    result.exportedCount = expectedRig.bindings.length;
    result.activeCount = activeRig.bindings.length;
    const comparison = compareJoysticks(expectedRig, activeRig, saved.profile, active.profile);
    if (comparison.status === 'match' && expectedRig.bindings.some(b => !catalog.definitions.has(idFor(b.context, b.action)))) {
      return unconfirmed('A bound action is absent from the installed action catalog.');
    }
    // A game save or export replacement during the check invalidates this observation.
    for (const { source } of [active, saved]) {
      const bytes = await readLimited(source.path, 16 * 1024 * 1024);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== source.revision) {
        return unconfirmed('A profile changed while it was being read. Check again.');
      }
    }
    return { ...result, ...comparison, checkedAt: new Date().toISOString() };
  } catch (error) {
    return unconfirmed('Could not compare the saved and active profiles. ' + error.message);
  }
}

module.exports = { loadProfile, listSources, listActions, saveLayout, verifyLayout, applyNextLaunch };
