// Fast drop-in replacement for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Returns exactly what csv-reader 1.0.0 returns for every input {text, header}:
// {columns, rows, errors}, following its written broken-row policy:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside
//     it one quote, and each CRLF or lone CR inside it read as LF; what follows its closing
//     quote, up to the next comma or line break, is appended as it stands (quote_junk, when
//     the field ends); a quote that never closes is a literal character, and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it (every record when header is false), each padded with "" (short_row, with
//     fields: its field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met: line the 1-based line its record
//     starts on, counting every LF, CRLF and lone CR inside quotes, and row its record's
//     index in rows, null for the header.
//
// Speed approach: the reference reads one character at a time and builds every field by
// string concatenation. This reader instead works in slices found with native scans:
//   - Fast path: a record with no quote is one physical line, found with one
//     indexOf('\n') and one indexOf('"') (no line is sliced unless it is quote-free);
//     split(',') then gives the fields at once. A trailing CR is the CRLF terminator
//     and is stripped from the last field; any other CR is a stray CR, dropped with its
//     stray_cr error. No per-character loop, no per-field concatenation.
//   - Slow path: only a record holding a quote is read field by field, and each field is
//     still read in slices: an unquoted field runs to the next comma or line break found
//     by indexOf, a quoted field runs to its closing quote found by indexOf('"'), with
//     doubled quotes folded in as segments joined once. Each CRLF or lone CR inside a
//     quoted field reads as LF, and line breaks inside quoted fields are counted per
//     segment with bounded indexOf scans, so error line numbers stay exact.
//   - Fields are carried in shared slots, not a fresh object per field, and a field that
//     is one slice is assigned from that slice directly instead of concatenated.
// Nothing is cached between cases: every call reads its own text from scratch.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and how many characters readUnquoted
  // kept (for quote_junk). Shared slots, so no object is built per field.
  let fv = '';
  let fe = 0;
  let fa = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // One segment of a quoted field (between its opening quote and its closing quote,
  // or between doubled quotes): each CRLF or lone CR inside it reads as LF, and every
  // line break in it moves the line on. Returns the segment as it goes in the value.
  function quotedSeg(seg) {
    if (seg.indexOf('\r') === -1) {
      let i = seg.indexOf('\n');
      while (i !== -1) {
        line += 1;
        i = seg.indexOf('\n', i + 1);
      }
      return seg;
    }
    const norm = seg.replace(/\r\n?/g, '\n');
    let i = norm.indexOf('\n');
    while (i !== -1) {
      line += 1;
      i = norm.indexOf('\n', i + 1);
    }
    return norm;
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not
  // followed by LF is dropped (stray_cr). Leaves the field in fv/fe and the characters
  // kept in fa (the starting value is not counted).
  function readUnquoted(value) {
    fa = 0;
    for (;;) {
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      let m;
      if (ci === -1) m = ni;
      else if (ni === -1) m = ci;
      else m = ci < ni ? ci : ni;
      if (m === -1) {
        // The rest of the text: it may hold stray CRs.
        const tail = text.slice(pos);
        const r = tail.indexOf('\r');
        if (r === -1) {
          fv = value === '' ? tail : value + tail;
          fa += tail.length;
        } else {
          let out = '';
          let start = 0;
          let j = r;
          let count = 0;
          while (j !== -1) {
            count += 1;
            out += tail.slice(start, j);
            start = j + 1;
            j = tail.indexOf('\r', start);
          }
          out += tail.slice(start);
          fv = value === '' ? out : value + out;
          fa += out.length;
          for (let k = 0; k < count; k += 1) error('stray_cr');
        }
        pos = n;
        fe = END;
        return;
      }
      const chunk = text.slice(pos, m);
      const r = chunk.indexOf('\r');
      if (r === -1) {
        fv = value === '' ? chunk : value + chunk;
        fa += chunk.length;
        if (m === ci) {
          pos = m + 1;
          fe = COMMA;
          return;
        }
        pos = m + 1;
        line += 1;
        fe = LINE_BREAK;
        return;
      }
      if (text.charCodeAt(pos + r + 1) === 10) {
        // CRLF: the field ends at the line break.
        const head = chunk.slice(0, r);
        fv = value === '' ? head : value + head;
        fa += r;
        pos = m + 1;
        line += 1;
        fe = LINE_BREAK;
        return;
      }
      // A stray CR: dropped, and the field goes on.
      error('stray_cr');
      const head = chunk.slice(0, r);
      value = value === '' ? head : value + head;
      fa += r;
      pos = pos + r + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Leaves the field in fv/fe.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let start = pos + 1;
    let parts = null;
    let value = '';
    for (;;) {
      const q = text.indexOf('"', start);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is
        // read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        readUnquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, and the field goes on.
        const seg = quotedSeg(text.slice(start, q));
        if (parts === null) parts = [seg, '"'];
        else {
          parts.push(seg);
          parts.push('"');
        }
        start = q + 2;
        continue;
      }
      const seg = quotedSeg(text.slice(start, q));
      if (parts === null) value = seg;
      else {
        parts.push(seg);
        value = parts.join('');
      }
      pos = q + 1;
      break;
    }
    if (pos >= n) {
      fv = value;
      fe = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fv = value;
      fe = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fv = value;
      fe = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fv = value;
      fe = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or
    // line break.
    readUnquoted(value);
    if (fa > 0) error('quote_junk');
  }

  // Finishes a record's fields: sets the width, takes the header, or pads/cuts and rows it.
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return; // no record
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

  while (pos < n) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? n : nl;
    const qi = text.indexOf('"', pos);
    if (qi === -1 || qi >= end) {
      // Fast path: no quote in this physical line, so the line IS the record: no
      // quoted field can span its line break, and its first LF ends it.
      const span = text.slice(pos, end);
      const terminated = nl !== -1;
      // A trailing CR is the CRLF terminator, not a stray CR: the only CR it can be is
      // the last character, so when the first CR sits there, no stray CR exists.
      const termCR = terminated && span.charCodeAt(span.length - 1) === 13;
      const firstCR = span.indexOf('\r');
      recordLine = line;
      recordRow = header && columns === null ? null : rows.length;
      let fields;
      if (firstCR === -1 || (termCR && firstCR === span.length - 1)) {
        fields = span.split(',');
        if (termCR) {
          const l = fields.length - 1;
          fields[l] = fields[l].slice(0, -1);
        }
      } else {
        const content = termCR ? span.slice(0, -1) : span;
        // Stray CRs: dropped, one stray_cr error each, in field order.
        const raw = content.split(',');
        fields = new Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) {
          const f = raw[i];
          const r = f.indexOf('\r');
          if (r === -1) {
            fields[i] = f;
            continue;
          }
          let out = '';
          let start = 0;
          let j = r;
          let count = 0;
          while (j !== -1) {
            count += 1;
            out += f.slice(start, j);
            start = j + 1;
            j = f.indexOf('\r', start);
          }
          out += f.slice(start);
          fields[i] = out;
          for (let k = 0; k < count; k += 1) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        }
      }
      finishRecord(fields, false);
      pos = terminated ? nl + 1 : n;
      if (terminated) line += 1;
      continue;
    }

    // Slow path: the record holds a quote, so it is read field by field.
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        readQuoted();
      } else {
        quoted = false;
        readUnquoted('');
      }
      fields.push(fv);
    } while (fe === COMMA);
    finishRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
