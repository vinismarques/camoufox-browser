const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'menuitem',
  'tab',
  'searchbox',
  'slider',
  'spinbutton',
  'switch'
]);

const SKIP_PATTERNS = [/date/i, /calendar/i, /picker/i, /datepicker/i];

function shouldSkipByName(name) {
  return Boolean(name) && SKIP_PATTERNS.some((pattern) => pattern.test(name));
}

function clip(value, max = 220) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function buildRefsFromAriaYaml(ariaYaml) {
  const refs = new Map();
  if (!ariaYaml) return refs;

  const lines = ariaYaml.split('\n');
  const seen = new Map();
  let index = 1;

  for (const line of lines) {
    const match = line.match(/^\s*-\s+(\w+)(?:\s+"([^"]*)")?/);
    if (!match) continue;

    const role = match[1].toLowerCase();
    const name = match[2] || '';

    if (!INTERACTIVE_ROLES.has(role)) continue;
    if (shouldSkipByName(name)) continue;

    const key = `${role}:${name}`;
    const nth = seen.get(key) || 0;
    seen.set(key, nth + 1);

    refs.set(`e${index++}`, {
      source: 'aria',
      strategy: 'role',
      role,
      name,
      nth
    });
  }

  return refs;
}

export function annotateAriaYamlWithRefs(ariaYaml, refs) {
  if (!ariaYaml || refs.size === 0) return ariaYaml || '';

  const reverse = new Map();
  for (const [ref, info] of refs.entries()) {
    if (info.strategy !== 'role') continue;
    reverse.set(`${info.role}:${info.name}:${info.nth}`, ref);
  }

  const seen = new Map();
  const lines = ariaYaml.split('\n');

  return lines.map((line) => {
    const match = line.match(/^(\s*-\s+)(\w+)(\s+"([^"]*)")?(.*)$/);
    if (!match) return line;

    const [, prefix, roleRaw, nameMatch, nameRaw, suffix] = match;
    const role = roleRaw.toLowerCase();
    const name = nameRaw || '';

    if (!INTERACTIVE_ROLES.has(role)) return line;
    if (shouldSkipByName(name)) return line;

    const countKey = `${role}:${name}`;
    const nth = seen.get(countKey) || 0;
    seen.set(countKey, nth + 1);

    const ref = reverse.get(`${role}:${name}:${nth}`);
    if (!ref) return line;

    return `${prefix}${roleRaw}${nameMatch || ''} [${ref}]${suffix}`;
  }).join('\n');
}

export function formatDomFallbackRefs(domFallbackRefs, options = {}) {
  const total = Array.isArray(domFallbackRefs) ? domFallbackRefs.length : 0;
  if (!total) {
    return {
      text: '',
      total,
      offset: 0,
      limit: 0,
      returned: 0,
      hasMore: false,
      nextOffset: 0
    };
  }

  const rawOffset = Number.parseInt(options.offset ?? '0', 10);
  const rawLimit = Number.parseInt(options.limit ?? `${total}`, 10);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
  const limit = Number.isFinite(rawLimit) ? Math.max(0, rawLimit) : total;
  const end = Math.min(total, offset + limit);
  const sliced = domFallbackRefs.slice(offset, end);

  const lines = [
    '',
    `DOM fallback refs (non-ARIA interactives) [${offset}-${Math.max(offset, end)}/${total}]:`
  ];

  for (const item of sliced) {
    const roleOrTag = item.role || item.tag || 'element';
    const label = clip(item.name || item.text || '<unnamed>', 120).replace(/\s+/g, ' ').trim();
    const selector = clip(item.selector || '', 220);
    const handleSuffix = item.handle ? ` handle="${item.handle}"` : '';
    lines.push(`- [${item.ref}] ${roleOrTag} "${label}" selector="${selector}"${handleSuffix}`);
  }

  const hasMore = end < total;
  if (hasMore) {
    lines.push(`- ... ${total - end} more refs. Use domRefOffset=${end} to continue.`);
  }

  return {
    text: lines.join('\n'),
    total,
    offset,
    limit,
    returned: sliced.length,
    hasMore,
    nextOffset: hasMore ? end : total
  };
}

export function sliceSnapshot(text, offset, maxChars) {
  const raw = text || '';
  const start = Math.max(0, offset || 0);
  const chunk = raw.slice(start, start + maxChars);
  const nextOffset = start + chunk.length;

  return {
    text: chunk,
    totalChars: raw.length,
    offset: start,
    nextOffset,
    truncated: raw.length > nextOffset,
    hasMore: raw.length > nextOffset
  };
}

export function isValidRoleRef(info) {
  return info?.strategy === 'role' && typeof info.role === 'string';
}

export function shouldSkipDomCandidateByName(name) {
  return shouldSkipByName(name || '');
}
