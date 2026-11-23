'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { readXml, serializeXml } = require('./xml.cjs');
const { lockProfile, readProfileFile } = require('./active-files.cjs');
const { isJoystickBinding, occupied, defaultJoystickRows, canonicalJoystickRows } = require('./joystick-bindings.cjs');
const { normalizeActivationMode } = require('../ui/binding-gesture.mjs');
const { isPedalToeAxis } = require('../ui/bindings.mjs');
const { stickFamily, isFalconPedals } = require('../rig/device-identity.mjs');

const element = (tag, attrs = {}) => ({ tag, attrs, children: [] });
const side = value => value === 'left' || value === 'right';
const routable = value => side(value) || value === 'pedals';
const validSlot = n => Number.isInteger(n) && n >= 1 && n <= 8;
const physicalKeyPattern = /^(?:button(?:[1-9]\d{0,2})|(?:flaps|gear)-axis|flaps-position-[23])$/;
const gameInputPattern = /^(?:button[1-9]\d{0,2}|hat[1-9]\d*_(?:up|down|left|right|rightup|rightdown|leftup|leftdown)|x|y|z|rotx|roty|rotz|slider[1-9]\d*)$/;

function bodyOf(node) {
  return node.xml ? node.xml.text.slice(node.xml.openEnd, node.xml.closeStart) : '';
}

function physicalSignature(context, action, attrs, key) {
  const fields = [context, action, attrs.input, attrs.multiTap || '', attrs.activationMode || '', key || ''];
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function readSemHint(context, action, node) {
  const text = node.provenanceComment ?? bodyOf(node);
  const marker = /<!-- (?:HOTAS UPLINK|VKBTOOL) SEM v1 ([a-f0-9]{64})(?: ([\w-]+))? -->/.exec(text);
  if (!marker || (marker[2] && !physicalKeyPattern.test(marker[2]))) return {};
  if (marker[1] !== physicalSignature(context, action, node.attrs, marker[2])) return {};
  return marker[2] ? { physicalDevice: 'sem', physicalKey: marker[2] } : { physicalDevice: 'sem' };
}

function readPhysicalHint(context, action, node) {
  const text = node.provenanceComment ?? bodyOf(node);
  const marker = /<!-- HOTAS UPLINK PEDALS v1 ([a-f0-9]{64}) (left-toe|right-toe) -->/.exec(text);
  if (!marker) return readSemHint(context, action, node);
  const axis = /^js\d+_(.+)$/i.exec(node.attrs.input || '')?.[1];
  if (!isPedalToeAxis(axis) || marker[1] !== physicalSignature(context, action, node.attrs, marker[2])) return {};
  return { physicalDevice: 'pedals', physicalKey: marker[2] };
}

function physicalHintComment(context, action, attrs, device, key) {
  if (device === 'sem' && key && !physicalKeyPattern.test(key)) throw new Error('Unknown SEM physical control.');
  if (device === 'pedals' && !['left-toe', 'right-toe'].includes(key)) throw new Error('Unknown pedal control.');
  const label = device === 'sem' ? 'SEM' : 'PEDALS';
  return '<!-- HOTAS UPLINK ' + label + ' v1 ' + physicalSignature(context, action, attrs, key) + (key ? ' ' + key : '') + ' -->';
}

function readHostHint(node, slot) {
  const marker = /<!-- (?:HOTAS UPLINK|VKBTOOL) HOST v1 (\d+) (left|right)(?: (virpil))? -->/.exec(node.provenanceComment ?? bodyOf(node));
  return marker && Number(marker[1]) === slot ? { device: marker[2], family: marker[3] } : null;
}

function hostHint(route) {
  const family = route.family === 'virpil' ? ' virpil' : '';
  return '<!-- HOTAS UPLINK HOST v1 ' + route.slot + ' ' + route.device + family + ' -->';
}

function child(parent, tag, attrs = {}) {
  const existing = parent.children.find(n => n.tag === tag && Object.entries(attrs).every(([k, v]) => n.attrs[k] === v));
  if (existing) return existing;
  const result = element(tag, attrs);
  parent.children.push(result);
  return result;
}

function checkName(name) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_-][\p{L}\p{N} ._-]{0,63}$/u.test(name) ||
      name !== name.trim() || name.endsWith('.') || name.includes('..')) {
    throw new Error('Use 1–64 letters, numbers, spaces, hyphens, underscores or periods for the layout name.');
  }
  return name;
}

function prepareProfile(profile, name) {
  const root = profile || element('ActionMaps');
  root.tag = 'ActionMaps';
  root.attrs.version ||= '1';
  root.attrs.optionsVersion ||= '2';
  root.attrs.rebindVersion ||= '2';
  root.attrs.profileName = name;
  let header = root.children.find(n => n.tag === 'CustomisationUIHeader');
  if (!header) {
    header = element('CustomisationUIHeader', { label: name, description: '', image: '' });
    root.children.unshift(header);
  }
  header.attrs.label = name;
  child(header, 'devices');
  child(header, 'categories');
  return { root, header };
}

function declareDevice(root, registry, route, deviceRole) {
  if (!validSlot(route.slot) || !routable(route.device)) throw new Error('Choose a controller and game slot before saving.');
  const existing = registry.get(route.slot);
  if (existing && routable(existing.device) && existing.device !== route.device) {
    throw new Error('The saved joystick slot belongs to a different controller.');
  }
  if (existing?.product && route.product && existing.product !== route.product) {
    throw new Error('The selected slot already records a different joystick product.');
  }
  if (route.device === 'pedals' && !(isFalconPedals(existing) || isFalconPedals(route.product))) {
    throw new Error('Choose the game slot for the VPC R1-FALCON pedals.');
  }
  if (existing && routable(existing.device)) return;
  const product = existing?.product || route.product || '';
  if (typeof product !== 'string' || product.length > 350 || /[\u0000-\u001f]/.test(product)) throw new Error('Invalid joystick product name.');
  const knownSide = deviceRole(product);
  if (routable(knownSide) && knownSide !== route.device) throw new Error('Joystick product and selected control disagree.');
  const opt = child(root, 'options', { type: 'joystick', instance: String(route.slot) });
  if (!opt.attrs.Product && product) opt.attrs.Product = product;
  if (!routable(knownSide)) opt.provenanceComment = hostHint(route);
  registry.set(route.slot, { slot: route.slot, device: route.device, product,
    ...(!product && route.family === 'virpil' ? { family: route.family } : {}) });
}

function ensureHeaderDevices(root, header, registry) {
  const devices = child(header, 'devices');
  const families = { js: 'joystick', kb: 'keyboard', mo: 'mouse', gp: 'gamepad' };
  for (const item of root.children) {
    if (item.tag === 'options' && item.attrs.type && item.attrs.Product) {
      if (Object.values(families).includes(item.attrs.type)) child(devices, item.attrs.type, { instance: item.attrs.instance || '1' });
    }
    if (item.tag !== 'actionmap') continue;
    for (const action of item.children) for (const binding of action.children) {
      const input = /^(js|kb|mo|gp)(\d+)_/i.exec(binding.attrs.input || '');
      if (input) child(devices, families[input[1].toLowerCase()], { instance: input[2] });
    }
  }
  for (const { slot } of registry.values()) child(devices, 'joystick', { instance: String(slot) });
}

function sameTarget(row, target, def, activationKey = String) {
  const attrs = row.attrs;
  if (typeof target?.input !== 'string' || !validSlot(target.slot)) return false;
  if (attrs.input.toLowerCase() !== ('js' + target.slot + '_' + target.input).toLowerCase()) return false;
  const taps = Number(attrs.multiTap ?? def?.multiTap) || 1;
  const activation = attrs.activationMode || def?.activationMode || '';
  return (target.multiTap == null || Number(target.multiTap) === taps) &&
    (target.activationMode == null || activationKey(target.activationMode) === activationKey(activation));
}

function applyEdit(root, def, edit, registry, deviceRole) {
  const group = child(root, 'actionmap', { name: def.context });
  const action = child(group, 'action', { name: def.action });
  const prior = action.children.filter(isJoystickBinding);
  if (!prior.some(row => row.tag === 'rebind')) action.children.unshift(...defaultJoystickRows(def));
  const alternatives = action.children.filter(n => isJoystickBinding(n) && occupied(n));
  let matches = [];
  if (edit.previous) {
    matches = alternatives.filter(n => sameTarget(n, edit.previous, def));
    if (matches.length !== 1) throw new Error('The previous assignment is ambiguous or has changed. Reload the layout.');
  } else if (edit.mode !== 'add') {
    if (alternatives.length > 1) throw new Error('Select which existing joystick assignment to change.');
    matches = alternatives;
  }
  let selected = matches[0];
  const matchingDevices = [...registry.values()].filter(d => d.device === edit.device);
  const slot = edit.slot ?? edit.previous?.slot ?? (matchingDevices.length === 1 ? matchingDevices[0].slot : undefined);
  if (!validSlot(slot)) throw new Error('Choose a game joystick slot before saving the binding.');
  if (edit.device !== undefined) declareDevice(root, registry, { slot, device: edit.device }, deviceRole);
  if (edit.input === null) {
    if (!selected) throw new Error('Select an existing joystick assignment to clear.');
    if (alternatives.length === 1) {
      selected.attrs = { input: 'js' + slot + '_ ' };
      selected.provenanceComment = '';
    } else {
      action.children = action.children.filter(n => n !== selected);
    }
    action.children = canonicalJoystickRows(action.children);
    return;
  }
  if (typeof edit.input !== 'string' || !gameInputPattern.test(edit.input)) throw new Error('Unsupported joystick input.');
  const input = 'js' + slot + '_' + edit.input;
  const attrs = { ...(selected?.attrs || {}), input };
  if (edit.multiTap != null) {
    if (!Number.isInteger(edit.multiTap) || edit.multiTap < 1 || edit.multiTap > 4) throw new Error('Invalid joystick tap count.');
    attrs.multiTap = String(edit.multiTap);
  }
  if (edit.activationMode !== undefined) {
    if (typeof edit.activationMode !== 'string' || !/^[\w]{0,64}$/.test(edit.activationMode)) throw new Error('Invalid activation mode.');
    if (edit.activationMode) attrs.activationMode = edit.activationMode;
    else delete attrs.activationMode;
  }
  const prospective = { slot, input: edit.input, multiTap: Number(attrs.multiTap ?? def.multiTap) || 1,
    activationMode: attrs.activationMode || def.activationMode || '' };
  if (alternatives.some(other => other !== selected && sameTarget(other, prospective, def, normalizeActivationMode))) {
    throw new Error('This action already has that joystick assignment.');
  }
  if (!selected) {
    selected = prior.find(n => !occupied(n)) || element(alternatives.length ? 'addbind' : 'rebind');
    if (!action.children.includes(selected)) action.children.push(selected);
  }
  // Preserve a physical-control hint across gesture edits. Changing the slot
  // or input requires new evidence for the SEM control or pedal axis.
  const unchanged = selected.attrs.input?.toLowerCase() === input.toLowerCase();
  const previousHint = unchanged ? readPhysicalHint(def.context, def.action, selected) : {};
  selected.attrs = attrs;
  const physical = edit.physicalDevice ?? previousHint.physicalDevice;
  selected.provenanceComment = '';
  if (physical === 'sem' || physical === 'pedals') {
    const key = edit.physicalKey ?? previousHint.physicalKey ?? '';
    if (physical === 'pedals' && (registry.get(slot)?.device !== 'pedals' || !isPedalToeAxis(edit.input))) {
      throw new Error('Choose a toe brake axis on the R1-FALCON pedals.');
    }
    selected.provenanceComment = physicalHintComment(def.context, def.action, attrs, physical, key);
  }
  action.children = canonicalJoystickRows(action.children);
}

function mappingDirectory(livePath) {
  return path.resolve(livePath, 'user/client/0/Controls/Mappings');
}

function checkLayoutFilename(filename) {
  if (typeof filename !== 'string' || !/\.xml$/i.test(filename) || /[<>:"/\\|?*\x00-\x1f]/.test(filename) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(filename) || path.basename(filename) !== filename) {
    throw new Error('Choose an XML layout in the game mappings folder.');
  }
}

async function checkedMappingDirectory(livePath) {
  const directory = mappingDirectory(livePath);
  const actual = await fs.realpath(directory);
  if (path.relative(mappingDirectory(await fs.realpath(livePath)), actual)) {
    throw new Error('The saved layout is outside the game mappings folder.');
  }
  return directory;
}

async function readNamedLayout(livePath, filename) {
  checkLayoutFilename(filename);
  try {
    const directory = await checkedMappingDirectory(livePath);
    const { bytes, revision, mode } = await readProfileFile(path.join(directory, filename));
    const root = readXml(bytes);
    if (root.tag !== 'ActionMaps' && root.tag !== 'ActionProfiles') throw new Error('Expected a Star Citizen saved layout.');
    return { revision, mode };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('The saved layout no longer exists. Choose a layout again.');
    throw error;
  }
}

async function namedLayoutRevision(livePath, filename) {
  return (await readNamedLayout(livePath, filename)).revision;
}

async function publishLayout(livePath, filename, text, overwrite) {
  const directory = overwrite ? await checkedMappingDirectory(livePath) : mappingDirectory(livePath);
  if (!overwrite) await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, filename);
  const temp = path.join(directory, '.hotas-uplink-' + crypto.randomUUID() + '.tmp');
  const unlock = overwrite ? await lockProfile(directory) : null;
  try {
    const handle = await fs.open(temp, 'wx', overwrite ? 0o600 : 0o666);
    try {
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      if (overwrite) {
        const current = await readNamedLayout(livePath, filename);
        if (current.revision !== overwrite.expectedRevision) {
          throw new Error('The saved layout changed on disk. Review it again before replacing it.');
        }
        if (process.platform !== 'win32') await fs.chmod(temp, current.mode);
        await fs.rename(temp, target);
      } else {
        try { await fs.link(temp, target); }
        catch (error) {
          if (error.code === 'EEXIST') throw new Error('A layout with that name already exists. Choose it to replace it, or use a new name.');
          throw error;
        }
      }
    } finally { await fs.rm(temp, { force: true }); }
  } finally { if (unlock) await unlock(); }
  return target;
}

async function writeLayout({ livePath, name, profile, blank, devices = [], edits = [], catalog, deviceRole, registry, overwrite }) {
  if (overwrite != null) {
    checkLayoutFilename(overwrite.filename);
    if (typeof overwrite.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(overwrite.expectedRevision)) {
      throw new Error('Review the saved layout before replacing it.');
    }
    // For an existing file the name is XML display text. Legacy profile names
    // need not satisfy the narrower rules for generating a new Windows filename.
    if (typeof name !== 'string' || !name.trim() || /[\x00-\x1f\uFFFE\uFFFF]/u.test(name)) throw new Error('Enter a valid layout name.');
  } else checkName(name);
  if (!Array.isArray(edits) || !Array.isArray(devices)) throw new Error('Invalid layout edits or devices.');
  const { root, header } = prepareProfile(profile, name);
  // The stock Gunfighter preset omits the right-side suffix from its product name.
  // Carry its known side into the standalone exported profile.
  for (const route of registry.values()) {
    if (side(route.device) && !side(deviceRole(route.product))) {
      const opt = child(root, 'options', { type: 'joystick', instance: String(route.slot) });
      opt.provenanceComment = hostHint(route);
    }
  }
  for (const route of devices) {
    const saved = registry.get(route.slot);
    const productFamily = isFalconPedals(route.product) ? 'virpil' : stickFamily(route.product);
    const family = route.family ?? productFamily;
    const savedFamily = isFalconPedals(saved) ? 'virpil' : stickFamily(saved);
    if (family && (
      !['vkb', 'virpil'].includes(family) ||
      (route.product && productFamily !== family) ||
      ((saved?.product || routable(saved?.device)) && savedFamily !== family)
    )) throw new Error('The selected slot and controller must belong to the same joystick family.');
    // The draft includes the whole source registry. Legacy slots and unrecognized
    // peripheral records are passthrough data, not new joystick declarations.
    if (saved && saved.device === route.device && saved.product === (route.product || '')) continue;
    declareDevice(root, registry, route, deviceRole);
  }
  if (blank || !profile) {
    if (!catalog.definitions.size) throw new Error('Creating a blank layout requires the installed action catalog.');
    const slot = registry.keys().next().value || 1;
    for (const def of catalog.definitions.values()) {
      if (!def.supportsJoystick) continue;
      const group = child(root, 'actionmap', { name: def.context });
      const action = child(group, 'action', { name: def.action });
      action.children.push(element('rebind', { input: 'js' + slot + '_ ' }));
    }
  }
  for (const edit of edits) {
    const def = catalog.definitions.get(edit.context + '/' + edit.action);
    // Older layouts can contain retired game actions. applyEdit requires the
    // selected source row to exist and be unique before clearing it.
    if (!def && !(edit.input === null && edit.previous)) throw new Error('This action is absent from the installed game catalog.');
    applyEdit(root, def || { context: edit.context, action: edit.action }, edit, registry, deviceRole);
  }
  ensureHeaderDevices(root, header, registry);
  const categories = child(header, 'categories');
  const contexts = new Set(root.children.filter(n => n.tag === 'actionmap').map(n => n.attrs.name));
  for (const def of catalog.definitions.values()) {
    if (def.category && contexts.has(def.context)) child(categories, 'category', { label: def.category });
  }
  const filename = overwrite?.filename ?? 'layout_' + name + '_exported.xml';
  const text = serializeXml(root);
  const result = await publishLayout(livePath, filename, text, overwrite);
  const revision = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  return { name, path: result, filename, revision, sourceId: 'export:' + filename };
}

module.exports = { writeLayout, namedLayoutRevision, readSemHint, readPhysicalHint, physicalHintComment, readHostHint, hostHint, semSignature: physicalSignature };
