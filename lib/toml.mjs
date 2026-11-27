// Pure Node TOML 1.0 parser with zero external or Python dependencies.
// Runs identically on Linux, macOS and Windows under the embedded Node 24 action runtime.

export class TomlError extends Error {
  constructor(message, line = 0) {
    super(line > 0 ? `TOML line ${line}: ${message}` : `TOML: ${message}`);
    this.name = "TomlError";
    this.line = line;
  }
}

const bareKeyChar = /[A-Za-z0-9_-]/;
const hexDigit = /[0-9A-Fa-f]/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createTable() {
  return Object.create(null);
}

function toPlain(value) {
  if (Array.isArray(value)) return value.map(toPlain);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = toPlain(value[key]);
    return out;
  }
  return value;
}

class Parser {
  constructor(source) {
    if (typeof source !== "string") throw new TomlError("Input must be a string.");
    this.input = source.replace(/\r\n/g, "\n");
    this.pos = 0;
    this.line = 1;
    this.root = createTable();
    this.current = this.root;
    this.definedTables = new WeakSet();
    this.implicitTables = new WeakSet();
    this.inlineObjects = new WeakSet();
    this.staticArrays = new WeakSet();
  }

  eof() {
    return this.pos >= this.input.length;
  }

  peek(offset = 0) {
    return this.input[this.pos + offset] ?? "";
  }

  startsWith(text) {
    return this.input.startsWith(text, this.pos);
  }

  advance() {
    const ch = this.input[this.pos++];
    if (ch === "\n") this.line++;
    return ch;
  }

  fail(message) {
    throw new TomlError(message, this.line);
  }

  skipInlineSpace() {
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === " " || ch === "\t") this.pos++;
      else break;
    }
  }

  skipComment() {
    if (this.peek() !== "#") return false;
    while (!this.eof() && this.peek() !== "\n") {
      const code = this.input.charCodeAt(this.pos);
      if ((code >= 0x00 && code <= 0x08) || (code >= 0x0b && code <= 0x1f) || code === 0x7f) {
        this.fail("Control character inside comment.");
      }
      this.pos++;
    }
    return true;
  }

  skipWhitespaceAndComments() {
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\n") {
        this.advance();
      } else if (ch === "#") {
        this.skipComment();
      } else {
        break;
      }
    }
  }

  expectEndOfLine() {
    this.skipInlineSpace();
    this.skipComment();
    if (!this.eof()) {
      if (this.peek() !== "\n") this.fail(`Unexpected character ${JSON.stringify(this.peek())}.`);
      this.advance();
    }
  }

  parse() {
    while (!this.eof()) {
      this.skipWhitespaceAndComments();
      if (this.eof()) break;
      if (this.peek() === "[") {
        this.parseTableHeader();
      } else {
        this.parseKeyValue(this.current, false);
        this.expectEndOfLine();
      }
    }
    return toPlain(this.root);
  }

  parseKeySegment() {
    this.skipInlineSpace();
    const ch = this.peek();
    if (ch === '"') return this.parseBasicString(false);
    if (ch === "'") return this.parseLiteralString(false);
    const start = this.pos;
    while (!this.eof() && bareKeyChar.test(this.peek())) this.pos++;
    if (this.pos === start) this.fail("Expected a key.");
    return this.input.slice(start, this.pos);
  }

  parseDottedKey() {
    const parts = [this.parseKeySegment()];
    while (true) {
      this.skipInlineSpace();
      if (this.peek() !== ".") break;
      this.pos++;
      parts.push(this.parseKeySegment());
    }
    return parts;
  }

  walkTablePath(root, keys, { allowArrayLast, isInline }) {
    let node = root;
    for (let i = 0; i < keys.length - 1; i++) {
      const part = keys[i];
      if (!Object.hasOwn(node, part)) {
        const next = createTable();
        this.implicitTables.add(next);
        if (isInline) this.inlineObjects.add(next);
        node[part] = next;
        node = next;
        continue;
      }
      const existing = node[part];
      if (allowArrayLast && Array.isArray(existing)) {
        if (this.staticArrays.has(existing) || existing.length === 0) {
          this.fail(`Cannot extend static array ${JSON.stringify(part)} as a table.`);
        }
        node = existing[existing.length - 1];
      } else if (isPlainObject(existing)) {
        if ((!allowArrayLast && this.definedTables.has(existing)) ||
            (!isInline && this.inlineObjects.has(existing))) {
          this.fail(`Cannot extend table ${JSON.stringify(part)}.`);
        }
        node = existing;
      } else {
        this.fail(`Key ${JSON.stringify(part)} is already defined as a non-table value.`);
      }
    }
    return node;
  }

  parseTableHeader() {
    this.pos++; // '['
    const isArrayTable = this.peek() === "[";
    if (isArrayTable) this.pos++;
    const keys = this.parseDottedKey();
    this.skipInlineSpace();
    if (isArrayTable) {
      if (!this.startsWith("]]")) this.fail("Expected ']]' to close array of tables header.");
      this.pos += 2;
    } else {
      if (this.peek() !== "]") this.fail("Expected ']' to close table header.");
      this.pos++;
    }
    this.expectEndOfLine();

    const node = this.walkTablePath(this.root, keys, { allowArrayLast: true, isInline: false });
    const leaf = keys[keys.length - 1];
    if (isArrayTable) {
      if (!Object.hasOwn(node, leaf)) {
        node[leaf] = [];
      } else if (!Array.isArray(node[leaf]) || this.staticArrays.has(node[leaf])) {
        this.fail(`Cannot redefine ${JSON.stringify(leaf)} as an array of tables.`);
      }
      const entry = createTable();
      this.definedTables.add(entry);
      node[leaf].push(entry);
      this.current = entry;
    } else {
      if (!Object.hasOwn(node, leaf)) {
        const table = createTable();
        this.definedTables.add(table);
        node[leaf] = table;
        this.current = table;
      } else {
        const existing = node[leaf];
        if (!isPlainObject(existing) || this.definedTables.has(existing) || this.inlineObjects.has(existing)) {
          this.fail(`Table ${JSON.stringify(keys.join("."))} cannot be redefined.`);
        }
        this.definedTables.add(existing);
        this.implicitTables.delete(existing);
        this.current = existing;
      }
    }
  }

  parseKeyValue(target, isInline) {
    const keys = this.parseDottedKey();
    this.skipInlineSpace();
    if (this.peek() !== "=") this.fail("Expected '=' after key.");
    this.pos++;
    this.skipInlineSpace();
    const value = this.parseValue();

    const node = this.walkTablePath(target, keys, { allowArrayLast: false, isInline });
    const leaf = keys[keys.length - 1];
    if (Object.hasOwn(node, leaf)) {
      this.fail(`Duplicate key ${JSON.stringify(keys.join("."))}.`);
    }
    node[leaf] = value;
  }

  parseValue() {
    this.skipInlineSpace();
    if (this.eof()) this.fail("Expected a value.");
    const ch = this.peek();
    if (ch === '"') {
      return this.startsWith('"""') ? this.parseBasicString(true) : this.parseBasicString(false);
    }
    if (ch === "'") {
      return this.startsWith("'''") ? this.parseLiteralString(true) : this.parseLiteralString(false);
    }
    if (ch === "[") return this.parseArray();
    if (ch === "{") return this.parseInlineTable();
    return this.parseScalar();
  }

  parseEscape() {
    const esc = this.advance();
    switch (esc) {
      case "b": return "\b";
      case "t": return "\t";
      case "n": return "\n";
      case "f": return "\f";
      case "r": return "\r";
      case '"': return '"';
      case "\\": return "\\";
      case "u":
      case "U": {
        const count = esc === "u" ? 4 : 8;
        let hex = "";
        for (let i = 0; i < count; i++) {
          const c = this.peek();
          if (!hexDigit.test(c)) this.fail(`Invalid unicode escape \\${esc}.`);
          hex += this.advance();
        }
        const cp = Number.parseInt(hex, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          this.fail("Invalid unicode scalar value.");
        }
        return String.fromCodePoint(cp);
      }
      default:
        this.fail(`Invalid escape sequence \\${esc}.`);
    }
  }

  parseMultilineString(quoteChar, allowEscapes) {
    const delimiter = quoteChar.repeat(3);
    this.pos += 3;
    if (this.peek() === "\n") this.advance();
    let out = "";
    while (!this.eof()) {
      if (this.startsWith(delimiter)) {
        let quotes = 0;
        while (this.peek(quotes) === quoteChar) quotes++;
        if (quotes > 5) this.fail("Too many consecutive quotes in multiline string.");
        this.pos += quotes;
        out += quoteChar.repeat(quotes - 3);
        return out;
      }
      if (allowEscapes && this.peek() === "\\") {
        this.pos++;
        if (this.peek() === " " || this.peek() === "\t" || this.peek() === "\n") {
          let sawNewline = false;
          while (!this.eof()) {
            const ws = this.peek();
            if (ws === " " || ws === "\t") this.pos++;
            else if (ws === "\n") { sawNewline = true; this.advance(); }
            else break;
          }
          if (!sawNewline) this.fail("Line-ending backslash must be followed by a newline.");
        } else {
          out += this.parseEscape();
        }
        continue;
      }
      const code = this.input.charCodeAt(this.pos);
      if ((code >= 0x00 && code <= 0x08) || (code >= 0x0b && code <= 0x1f) || code === 0x7f) {
        this.fail("Control character in multiline string.");
      }
      out += this.advance();
    }
    this.fail("Unterminated multiline string.");
  }

  parseBasicString(multiline) {
    if (multiline) return this.parseMultilineString('"', true);

    this.pos++; // '"'
    let out = "";
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch === "\n") this.fail("Newline inside single-line basic string.");
      if (ch === "\\") {
        this.pos++;
        out += this.parseEscape();
        continue;
      }
      const code = this.input.charCodeAt(this.pos);
      if ((code >= 0x00 && code <= 0x08) || (code >= 0x0a && code <= 0x1f) || code === 0x7f) {
        this.fail("Unescaped control character in basic string.");
      }
      out += this.advance();
    }
    this.fail("Unterminated basic string.");
  }

  parseLiteralString(multiline) {
    if (multiline) return this.parseMultilineString("'", false);

    this.pos++; // "'"
    let out = "";
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === "'") {
        this.pos++;
        return out;
      }
      if (ch === "\n") this.fail("Newline inside single-line literal string.");
      const code = this.input.charCodeAt(this.pos);
      if ((code >= 0x00 && code <= 0x08) || (code >= 0x0a && code <= 0x1f) || code === 0x7f) {
        this.fail("Control character in literal string.");
      }
      out += this.advance();
    }
    this.fail("Unterminated literal string.");
  }

  parseArray() {
    this.pos++; // '['
    const items = [];
    this.staticArrays.add(items);
    while (true) {
      this.skipWhitespaceAndComments();
      if (this.eof()) this.fail("Unterminated array.");
      if (this.peek() === "]") {
        this.pos++;
        return items;
      }
      items.push(this.parseValue());
      this.skipWhitespaceAndComments();
      const ch = this.peek();
      if (ch === ",") {
        this.pos++;
      } else if (ch === "]") {
        this.pos++;
        return items;
      } else {
        this.fail("Expected ',' or ']' in array.");
      }
    }
  }

  parseInlineTable() {
    this.pos++; // '{'
    const table = createTable();
    this.inlineObjects.add(table);
    this.skipInlineSpace();
    if (this.peek() === "}") {
      this.pos++;
      return table;
    }
    while (true) {
      this.skipInlineSpace();
      if (this.eof() || this.peek() === "\n") this.fail("Unterminated inline table.");
      this.parseKeyValue(table, true);
      this.skipInlineSpace();
      const ch = this.peek();
      if (ch === ",") {
        this.pos++;
        this.skipInlineSpace();
        if (this.peek() === "}") this.fail("Trailing comma is not allowed in TOML 1.0 inline tables.");
      } else if (ch === "}") {
        this.pos++;
        return table;
      } else {
        this.fail("Expected ',' or '}' in inline table.");
      }
    }
  }

  parseScalar() {
    const start = this.pos;
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "#" || ch === "," || ch === "]" || ch === "}") {
        // RFC 3339 datetimes can use a space separator between date and time.
        if (ch === " " && /^\d{4}-\d{2}-\d{2}$/.test(this.input.slice(start, this.pos)) &&
            /^\d{2}:\d{2}:\d{2}/.test(this.input.slice(this.pos + 1, this.pos + 9))) {
          this.pos++;
          continue;
        }
        break;
      }
      this.pos++;
    }
    const token = this.input.slice(start, this.pos);
    if (!token) this.fail("Expected a scalar value.");
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "inf" || token === "+inf") return Infinity;
    if (token === "-inf") return -Infinity;
    if (token === "nan" || token === "+nan" || token === "-nan") return Number.NaN;

    // RFC 3339 offset datetime, local datetime, local date or local time.
    if (/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/.test(token) ||
        /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(token)) {
      return token;
    }

    // Hex, octal, binary integers.
    if (/^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/.test(token)) {
      return Number.parseInt(token.slice(2).replaceAll("_", ""), 16);
    }
    if (/^0o[0-7](?:_?[0-7])*$/.test(token)) {
      return Number.parseInt(token.slice(2).replaceAll("_", ""), 8);
    }
    if (/^0b[01](?:_?[01])*$/.test(token)) {
      return Number.parseInt(token.slice(2).replaceAll("_", ""), 2);
    }

    // Decimal integer (no leading zero unless single 0).
    if (/^[+-]?(?:0|[1-9](?:_?[0-9])*)$/.test(token)) {
      const value = Number(token.replaceAll("_", ""));
      if (!Number.isSafeInteger(value)) this.fail(`Integer ${token} exceeds safe JS range.`);
      return value;
    }

    // Float.
    if (/^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?|[eE][+-]?[0-9](?:_?[0-9])*)$/.test(token)) {
      return Number(token.replaceAll("_", ""));
    }

    this.fail(`Invalid scalar value ${JSON.stringify(token)}.`);
  }
}

export function parseToml(source) {
  return new Parser(source).parse();
}
