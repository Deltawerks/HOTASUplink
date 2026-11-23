'use strict';

function isJoystickBinding(row) {
  return (row.tag === 'rebind' || row.tag === 'addbind') && /^js\d+_/i.test(row.attrs.input || '');
}

function occupied(row) {
  return /^js\d+_\s*\S/i.test(row.attrs.input || '');
}

function defaultJoystickRows(definition) {
  return (definition?.defaults || []).filter(attrs => attrs.input?.trim()).map((attrs, index) => {
    const input = attrs.input.trim();
    return {
      tag: index === 0 ? 'rebind' : 'addbind',
      attrs: { ...attrs, input: /^js\d+_/i.test(input) ? input : 'js1_' + input },
      children: []
    };
  });
}

// A rebind overrides joystick defaults, including when its input is blank.
// An addbind alone supplements the default input.
function effectiveJoystickRows(action, definition) {
  const rows = action?.children.filter(isJoystickBinding) || [];
  return rows.some(row => row.tag === 'rebind') ? rows : [...defaultJoystickRows(definition), ...rows];
}

// Keep the existing primary where possible. Removing it promotes an alternative.
// Leave other device families, sibling order and original XML metadata intact.
function canonicalJoystickRows(rows) {
  const joystick = rows.filter(isJoystickBinding);
  const bound = joystick.filter(occupied);
  const primary = bound.find(row => row.tag === 'rebind') || bound[0] || joystick[0];
  return rows.filter(row => !isJoystickBinding(row) || row === primary || occupied(row)).map(row => {
    if (!isJoystickBinding(row)) return row;
    const tag = row === primary ? 'rebind' : 'addbind';
    return row.tag === tag ? row : { ...row, tag };
  });
}

module.exports = { isJoystickBinding, occupied, defaultJoystickRows, effectiveJoystickRows, canonicalJoystickRows };
