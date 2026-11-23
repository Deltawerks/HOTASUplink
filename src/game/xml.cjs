'use strict';

// CryXmlB stores node headers, attributes, child indices and NUL-terminated UTF-8
// strings in separate tables. Both encodings below return { tag, attrs, children }.
function readBinaryXml(bytes) {
  const nodesAt = bytes.readUInt32LE(12), count = bytes.readUInt32LE(16);
  const attrsAt = bytes.readUInt32LE(20), attrCount = bytes.readUInt32LE(24);
  const childrenAt = bytes.readUInt32LE(28), childCount = bytes.readUInt32LE(32);
  const stringsAt = bytes.readUInt32LE(36), stringsSize = bytes.readUInt32LE(40);
  if (!count || nodesAt + 28 * count > bytes.length || attrsAt + 8 * attrCount > bytes.length ||
      childrenAt + 4 * childCount > bytes.length || stringsAt + stringsSize > bytes.length) {
    throw new Error('Invalid CryXmlB table bounds');
  }
  const stringCache = new Map();
  function stringAt(offset) {
    if (stringCache.has(offset)) return stringCache.get(offset);
    const end = bytes.indexOf(0, stringsAt + offset);
    if (offset >= stringsSize || end < 0 || end >= stringsAt + stringsSize) throw new Error('Invalid CryXmlB string');
    const value = bytes.toString('utf8', stringsAt + offset, end);
    stringCache.set(offset, value);
    return value;
  }
  const nodes = Array.from({ length: count }, () => ({ tag: '', attrs: Object.create(null), children: [] }));
  for (let id = 0; id < count; id++) {
    const i = nodesAt + id * 28;
    const node = nodes[id];
    node.tag = stringAt(bytes.readUInt32LE(i));
    const attrStart = bytes.readUInt32LE(i + 16), nAttrs = bytes.readUInt16LE(i + 8);
    const childStart = bytes.readUInt32LE(i + 20), nChildren = bytes.readUInt16LE(i + 10);
    if (attrStart + nAttrs > attrCount || childStart + nChildren > childCount) throw new Error('Invalid CryXmlB node');
    for (let k = 0; k < nAttrs; k++) {
      const a = attrsAt + 8 * (attrStart + k);
      node.attrs[stringAt(bytes.readUInt32LE(a))] = stringAt(bytes.readUInt32LE(a + 4));
    }
    for (let k = 0; k < nChildren; k++) {
      const index = bytes.readUInt32LE(childrenAt + 4 * (childStart + k));
      if (index >= count || index === id) throw new Error('Invalid CryXmlB child');
      node.children.push(nodes[index]);
    }
  }
  return nodes[0];
}

function decode(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#x[\da-fA-F]+;|#\d+;)/.test(value)) throw new Error('Invalid XML entity');
  return value.replace(/&(amp|lt|gt|quot|apos|#x[\da-fA-F]+|#\d+);/g, (_, token) => {
    if (token in entities) return entities[token];
    const point = token.startsWith('#x') ? parseInt(token.slice(2), 16) : Number(token.slice(1));
    if (!(point === 9 || point === 10 || point === 13 || (point >= 32 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff))) {
      throw new Error('Invalid XML character reference');
    }
    return String.fromCodePoint(point);
  });
}

// Game profile values are attributes. External entities and document types have
// no role in a control profile and are rejected.
function readTextXml(text) {
  const document = { children: [] }, stack = [document];
  const tokens = /<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<\?[^]*?\?>|<\/?[\w:.-]+(?:[^>"']|"[^"]*"|'[^']*')*>/gy;
  const attributes = /\s+([\w:.-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/gy;
  let position = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (position < text.length) {
    const open = text.indexOf('<', position);
    const gap = text.slice(position, open < 0 ? text.length : open);
    if (stack.length === 1 && /[^ \t\r\n]/.test(gap)) throw new Error('Unexpected text outside the XML document');
    if (gap.includes(']]>')) throw new Error('Unexpected CDATA terminator');
    if (gap.includes('&')) decode(gap);
    if (open < 0) break;
    tokens.lastIndex = open;
    const match = tokens.exec(text);
    if (!match) throw new Error('Unsupported or malformed profile XML');
    position = tokens.lastIndex;
    const tagText = match[0];
    if (tagText.startsWith('<!--')) {
      if (tagText.slice(4, -3).includes('--') || tagText.endsWith('--->')) throw new Error('Invalid XML comment');
      continue;
    }
    if (tagText.startsWith('<?')) continue;
    if (tagText.startsWith('<![CDATA[')) {
      if (stack.length === 1) throw new Error('Unexpected CDATA outside the XML document');
      continue;
    }
    if (tagText.startsWith('</')) {
      const closing = tagText.slice(2, -1).trim();
      const last = stack.pop();
      if (!last || last.tag !== closing) throw new Error('Mismatched XML closing tag');
      last.xml.closeStart = open;
      last.xml.end = position;
      continue;
    }
    const tag = /^<([\w:.-]+)/.exec(tagText)[1];
    const node = { tag, attrs: Object.create(null), children: [] };
    let offset = tag.length + 1;
    attributes.lastIndex = offset;
    for (let a; (a = attributes.exec(tagText));) {
      if (Object.hasOwn(node.attrs, a[1])) throw new Error('Duplicate XML attribute: ' + a[1]);
      node.attrs[a[1]] = decode(a[2] ?? a[3]);
      offset = attributes.lastIndex;
    }
    if (!/^\s*\/?>$/.test(tagText.slice(offset))) throw new Error('Invalid XML attributes on ' + tag);
    node.xml = { text, start: open, openEnd: position, closeStart: position, end: position,
      tag, attrs: { ...node.attrs }, originalChildren: [] };
    if (stack.at(-1).xml) stack.at(-1).xml.originalChildren.push(node);
    stack[stack.length - 1].children.push(node);
    if (!tagText.endsWith('/>')) stack.push(node);
  }
  if (stack.length !== 1 || document.children.length !== 1) throw new Error('Incomplete profile XML');
  return document.children[0];
}

const escapeAttr = value => String(value).replace(/[&<>"\r\n\t]/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\r': '&#13;', '\n': '&#10;', '\t': '&#9;'
})[c]);

// Reuse unchanged XML tags and all original text (including comments) between children.
// New children are inserted at their designated position in the element order.
function writeNode(node, depth = 0) {
  const { xml, tag, attrs, children } = node;
  const text = xml?.text || '';
  const sameAttrs = xml && tag === xml.tag && Object.keys(attrs).length === Object.keys(xml.attrs).length &&
    Object.entries(attrs).every(([key, value]) => xml.attrs[key] === value);
  const open = sameAttrs ? text.slice(xml.start, xml.openEnd) :
    '<' + tag + Object.entries(attrs).map(([k, v]) => ' ' + k + '="' + escapeAttr(v) + '"').join('') + '>';
  const hasOldBody = xml && xml.closeStart !== xml.end;
  const after = hasOldBody && tag === xml.tag ? text.slice(xml.closeStart, xml.end) : '</' + tag + '>';
  if (!children.length && !hasOldBody && !node.provenanceComment) return open.endsWith('/>') ? open : open.slice(0, -1) + '/>';

  let body = '';
  let cursor = xml?.openEnd ?? 0;
  let index = 0;
  const original = xml?.originalChildren || [];
  const present = new Set(children);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = newline + ' '.repeat(depth + 1);
  for (const child of children) {
    while (index < original.length && !present.has(original[index])) {
      const removed = original[index++].xml;
      body += text.slice(cursor, removed.start);
      cursor = removed.end;
    }
    if (original[index] === child) {
      body += text.slice(cursor, child.xml.start);
      cursor = child.xml.end;
      index++;
    } else body += indent;
    body += writeNode(child, depth + 1);
  }
  for (; index < original.length; index++) {
    const removed = original[index].xml;
    body += text.slice(cursor, removed.start);
    cursor = removed.end;
  }
  body += hasOldBody ? text.slice(cursor, xml.closeStart) : newline + ' '.repeat(depth);
  if (node.provenanceComment !== undefined) {
    body = body.replace(/<!-- (?:HOTAS UPLINK|VKBTOOL) (?:SEM v1 [0-9a-f]{64}(?: [\w-]+)?|PEDALS v1 [0-9a-f]{64} (?:left-toe|right-toe)|HOST v1 \d+ (?:left|right)(?: virpil)?) -->/g, '') + node.provenanceComment;
  }
  return open.replace(/\s*\/>$/, '>') + body + after;
}

function serializeXml(node) {
  // Preserve a named export's document declaration, comments and final newline.
  const original = node.xml;
  if (original && original.tag === 'ActionMaps') {
    return original.text.slice(0, original.start) + writeNode(node) + original.text.slice(original.end);
  }
  return writeNode(node) + '\n';
}

function readXml(bytes) {
  return bytes.subarray(0, 8).equals(Buffer.from('CryXmlB\0')) ? readBinaryXml(bytes) : readTextXml(bytes.toString('utf8'));
}

module.exports = { readXml, serializeXml };
