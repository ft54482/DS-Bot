/**
 * Minimal, dependency-free YAML reader for loop configs.
 *
 * Supported subset:
 *
 *  - block mappings (`key: value`) and nested mappings by indentation;
 *  - block sequences of scalars (`- value`) and of mappings (`- key: value`);
 *  - single- and double-quoted scalars, including `''` and JSON-style escapes;
 *  - unquoted strings, integers, floats, booleans and null (`null`, `~`);
 *  - comments introduced by `#` after a space, outside quotes;
 *  - blank lines and a leading UTF-8 BOM.
 *
 * Not supported on purpose: anchors/aliases, tags, block scalars (`|`, `>`),
 * flow collections (`[...]`, `{...}`), multi-document streams and tabs used for
 * indentation. Those throw a {@link YamlError} instead of being guessed at.
 *
 * The parser is intentionally strict about indentation and duplicate keys: a
 * loop config that is ambiguous is an invalid config, not a best effort.
 */

/** Error raised for any malformed source. `line` is 1-based when known. */
export class YamlError extends Error {
  constructor(message, line = null) {
    super(line === null ? message : `${message} (line ${line})`);
    this.name = 'YamlError';
    this.line = line;
  }
}

const TRUE_VALUES = new Set(['true', 'True', 'TRUE']);
const FALSE_VALUES = new Set(['false', 'False', 'FALSE']);
const NULL_VALUES = new Set(['null', 'Null', 'NULL', '~']);
const INTEGER_PATTERN = /^[+-]?\d+$/;
const FLOAT_PATTERN = /^[+-]?(?:(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+)$/;

/**
 * Parse a YAML document.
 *
 * @param {string} text
 * @returns {unknown} the parsed document, or `null` for an empty document
 * @throws {YamlError} when the source uses syntax outside the supported subset
 */
export function parseYaml(text) {
  if (typeof text !== 'string') {
    throw new YamlError('YAML source must be a string');
  }

  const tokens = tokenize(text.replace(/^\uFEFF/, ''));
  if (tokens.length === 0) return null;
  if (tokens[0].indent !== 0) {
    throw new YamlError('document must start at indentation 0', tokens[0].line);
  }

  const parsed = parseNode(tokens, 0, 0);
  if (parsed.index < tokens.length) {
    throw new YamlError('unexpected indentation', tokens[parsed.index].line);
  }
  return parsed.value;
}

function tokenize(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const tokens = [];

  lines.forEach((raw, index) => {
    const line = index + 1;
    const leading = /^[ \t]*/.exec(raw)[0];
    if (leading.includes('\t')) {
      throw new YamlError('tabs are not allowed for indentation', line);
    }

    const content = stripComment(raw.slice(leading.length)).replace(/[ \t]+$/, '');
    if (content.trim() === '') return;

    tokens.push({ indent: leading.length, content, line });
  });

  return tokens;
}

function stripComment(content) {
  let single = false;
  let double = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (single) {
      if (char === "'") {
        if (content[index + 1] === "'") index += 1;
        else single = false;
      }
      continue;
    }

    if (double) {
      if (char === '\\') index += 1;
      else if (char === '"') double = false;
      continue;
    }

    if (char === "'") single = true;
    else if (char === '"') double = true;
    else if (char === '#' && (index === 0 || content[index - 1] === ' ' || content[index - 1] === '\t')) {
      return content.slice(0, index);
    }
  }

  return content;
}

function parseNode(tokens, index, indent) {
  return isSequenceItem(tokens[index].content)
    ? parseSequence(tokens, index, indent)
    : parseMapping(tokens, index, indent);
}

function parseMapping(tokens, index, indent) {
  const value = {};

  while (index < tokens.length && tokens[index].indent === indent) {
    const token = tokens[index];
    if (isSequenceItem(token.content)) {
      throw new YamlError('unexpected sequence item in a mapping', token.line);
    }

    const colon = findPairColon(token.content);
    if (colon === -1) {
      throw new YamlError('expected "key: value"', token.line);
    }

    const key = parseKey(token.content.slice(0, colon).trim(), token.line);
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throw new YamlError(`duplicate key "${key}"`, token.line);
    }

    const rest = token.content.slice(colon + 1).trim();
    index += 1;

    if (rest !== '') {
      value[key] = parseScalar(rest, token.line);
      if (index < tokens.length && tokens[index].indent > indent) {
        throw new YamlError(`unexpected indentation after "${key}"`, tokens[index].line);
      }
    } else if (index < tokens.length && tokens[index].indent > indent) {
      const child = parseNode(tokens, index, tokens[index].indent);
      value[key] = child.value;
      index = child.index;
    } else {
      value[key] = null;
    }
  }

  return { value, index };
}

function parseSequence(tokens, index, indent) {
  const value = [];

  while (
    index < tokens.length
    && tokens[index].indent === indent
    && isSequenceItem(tokens[index].content)
  ) {
    const token = tokens[index];
    const rest = token.content === '-' ? '' : token.content.slice(1).trim();
    index += 1;

    if (rest === '') {
      if (index < tokens.length && tokens[index].indent > indent) {
        const child = parseNode(tokens, index, tokens[index].indent);
        value.push(child.value);
        index = child.index;
      } else {
        value.push(null);
      }
      continue;
    }

    if (findPairColon(rest) !== -1) {
      // `- key: value` starts a mapping whose following keys align with `key`.
      tokens[index - 1] = { ...token, indent: indent + 2, content: rest };
      const child = parseMapping(tokens, index - 1, indent + 2);
      value.push(child.value);
      index = child.index;
      continue;
    }

    value.push(parseScalar(rest, token.line));
    if (index < tokens.length && tokens[index].indent > indent) {
      throw new YamlError('unexpected indentation after a sequence item', tokens[index].line);
    }
  }

  return { value, index };
}

function isSequenceItem(content) {
  return content === '-' || content.startsWith('- ');
}

function findPairColon(content) {
  let single = false;
  let double = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (single) {
      if (char === "'") {
        if (content[index + 1] === "'") index += 1;
        else single = false;
      }
      continue;
    }

    if (double) {
      if (char === '\\') index += 1;
      else if (char === '"') double = false;
      continue;
    }

    if (char === "'") single = true;
    else if (char === '"') double = true;
    else if (char === ':') {
      const next = content[index + 1];
      if (next === undefined || next === ' ' || next === '\t') return index;
    }
  }

  return -1;
}

function parseKey(raw, line) {
  if (raw === '') throw new YamlError('mapping key must not be empty', line);
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const key = parseScalar(raw, line);
    if (typeof key !== 'string') {
      throw new YamlError('mapping key must be a string', line);
    }
    return key;
  }
  return raw;
}

function parseScalar(text, line) {
  if (text.startsWith('"')) return parseDoubleQuoted(text, line);
  if (text.startsWith("'")) return parseSingleQuoted(text, line);
  if (text.startsWith('[') || text.startsWith('{')) {
    throw new YamlError('flow collections are not supported', line);
  }
  if (/^[|>][+-]?\d*$/.test(text)) {
    throw new YamlError('block scalars are not supported', line);
  }
  if (TRUE_VALUES.has(text)) return true;
  if (FALSE_VALUES.has(text)) return false;
  if (NULL_VALUES.has(text)) return null;
  if (INTEGER_PATTERN.test(text) || FLOAT_PATTERN.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

function parseDoubleQuoted(text, line) {
  try {
    const value = JSON.parse(text);
    if (typeof value !== 'string') throw new Error('not a string');
    return value;
  } catch {
    throw new YamlError('invalid double-quoted scalar', line);
  }
}

function parseSingleQuoted(text, line) {
  let value = '';

  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "'") {
      value += char;
      continue;
    }
    if (text[index + 1] === "'") {
      value += "'";
      index += 1;
      continue;
    }
    if (index !== text.length - 1) {
      throw new YamlError('unexpected text after a quoted scalar', line);
    }
    return value;
  }

  throw new YamlError('unterminated single-quoted scalar', line);
}
