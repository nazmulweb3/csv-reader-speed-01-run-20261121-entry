// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answers as the reference on every input, but built for speed:
// a plain record (no quotes, no carriage returns on its line) is split
// with indexOf/slice instead of one character at a time, and a quoted
// field is consumed a whole segment at a time up to its next quote.
// Only records that actually hold a quote or a stray CR take the slow
// character-by-character road, which mirrors the reference exactly.
//
// Semantics kept from the reference, in full:
//  - a U+FEFF at the very start is dropped;
//  - a record ends at LF or CRLF; a line left with no characters is no record;
//  - outside quotes a CR not followed by LF is dropped (stray_cr);
//  - a field opening with a quote runs to the next quote that is not
//    doubled ("" inside it is one quote; each CRLF or lone CR inside it
//    reads as LF); what follows its closing quote, up to the next comma
//    or line break, is appended as it stands (quote_junk, when the field
//    ends); a quote that never closes is a literal character and the text
//    after it is read again as unquoted (unterminated_quote);
//  - a quote inside an unquoted field is a literal character;
//  - fields stay strings, never trimmed or converted;
//  - columns is the first record when header is true, else null; rows
//    hold the records after it (every record when header is false), each
//    padded with "" (short_row, with fields: its count) or cut (long_row,
//    with extra: the cut fields) to the first record's width;
//  - each error is {code, line, row}, in the order met, a record's
//    short_row or long_row when it ends: line the 1-based line its record
//    starts on, counting every LF, CRLF and lone CR inside quotes, and
//    row its record's index in rows, null for the header.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call
// to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows
  // it takes (null: the header). Set fresh for every record.
  let recordLine = 1;
  let recordRow = null;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns
  // [value, ended, added], where added counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        // ,
        pos += 1;
        return [value, COMMA, added];
      }
      if (c === 10) {
        // LF
        pos += 1;
        line += 1;
        return [value, LINE_BREAK, added];
      }
      if (c === 13) {
        // CR: CRLF ends the field, a lone CR is dropped (stray_cr).
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          return [value, LINE_BREAK, added];
        }
        pushError('stray_cr');
        pos += 1;
        continue;
      }
      // A run of ordinary characters, taken whole.
      let end = pos + 1;
      while (end < n) {
        const d = text.charCodeAt(end);
        if (d === 44 || d === 10 || d === 13) break;
        end += 1;
      }
      value += text.slice(pos, end);
      added += end - pos;
      pos = end;
    }
    return [value, END, added];
  }

  // The text in [from, to) as a quoted field holds it: each CRLF or lone
  // CR inside it one LF, and every line break inside it counted.
  function quotedSegment(from, to) {
    const s = text.slice(from, to);
    const cr = s.indexOf('\r');
    if (cr === -1) {
      let count = 0;
      let i = -1;
      while ((i = s.indexOf('\n', i + 1)) !== -1) count += 1;
      line += count;
      return s;
    }
    let out = '';
    for (let i = 0; i < s.length; i += 1) {
      const ch = s.charCodeAt(i);
      if (ch === 13) {
        out += '\n';
        line += 1;
        if (s.charCodeAt(i + 1) === 10) i += 1;
      } else if (ch === 10) {
        out += '\n';
        line += 1;
      } else {
        out += s[i];
      }
    }
    return out;
  }

  // Reads a quoted field whose opening quote is at pos.
  // Returns [value, ended, added] like readUnquoted.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    while (pos < n) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      value += quotedSegment(pos, q);
      if (text.charCodeAt(q + 1) === 34) {
        value += '"';
        pos = q + 2;
        continue;
      }
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as an unquoted field.
      pos = open + 1;
      line = openLine;
      pushError('unterminated_quote');
      return readUnquoted('"');
    }
    if (pos >= n) return [value, END, 0];
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return [value, COMMA, 0];
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return [value, LINE_BREAK, 0];
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return [value, LINE_BREAK, 0];
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk[2] > 0) pushError('quote_junk');
    return junk;
  }

  // Files a finished record: header, padding/cutting to the first
  // record's width, and its short_row/long_row error when it ends.
  function emitRecord(fields, quoted) {
    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text.charCodeAt(pos) === 10) {
        pos += 1;
        line += 1;
      } else if (text.charCodeAt(pos) === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast road: the record sits on one line that holds no quote and no
    // carriage return, so it ends at the next LF and splits on commas.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const q = text.indexOf('"', pos);
    const cr = text.indexOf('\r', pos);
    if ((q === -1 || q >= lineEnd) && (cr === -1 || cr >= lineEnd)) {
      const fields = [];
      let f = pos;
      while (true) {
        const comma = text.indexOf(',', f);
        if (comma === -1 || comma >= lineEnd) {
          fields.push(text.slice(f, lineEnd));
          break;
        }
        fields.push(text.slice(f, comma));
        f = comma + 1;
      }
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
      emitRecord(fields, false);
      continue;
    }

    // Slow road: the record holds a quote or a carriage return, so it
    // may span lines and needs the field-by-field reading.
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field[0]);
    } while (field[1] === COMMA);
    emitRecord(fields, quoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
