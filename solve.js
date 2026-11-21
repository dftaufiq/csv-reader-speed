// A fast drop-in for make.fun's csv-reader 1.0.0: run(input) returns exactly csv-reader's
// reading of {text, header} as {columns, rows, errors}, but reads the text with native
// indexOf jumps and per-line splits instead of one character at a time.
//
// The policy it reproduces (csv-reader 1.0.0's, make.fun's own):
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside
//     it one quote, and each CRLF or lone CR inside it is read as LF; what follows its
//     closing quote, up to the next comma or line break, is appended as it stands
//     (quote_junk, when the field ends); a quote that never closes is a literal character,
//     and the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it (every record when header is false), each padded with "" (short_row, with
//     fields: its count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met, a field's quote_junk when the
//     field ends and a record's short_row or long_row when the record ends: line the
//     1-based line its record starts on (every LF, CRLF and lone CR inside a quoted field
//     counted), row its record's index in rows (null for the header).
//
// How it is fast: a record whose first physical line holds no quote and no stray CR is
// split by the native String split in one call. Any other record is read field by field,
// each unquoted field found with one indexOf(',') against the line extent cached for the
// line the field sits on, each quoted field found with indexOf('"') jumps over its
// doubled quotes. The rare paths (junk after a closing quote, a quote that never closes,
// a stray CR inside a field) go through scanUnquoted, which follows the reference step
// by step. Line numbers are kept exactly: every line break consumed, inside quotes
// included, counts once.

/** A CRLF or a lone CR inside a quoted field, each read as one LF. */
const CR_RE = /\r\n?/g;


/** How a field ended: at a comma (the record goes on), at a line break, at the end. */
const COMMA = 0;
const BREAK = 1;
const END = 2;

// Scan an unquoted field starting at `start` with initial value `init`: it runs to the
// next comma, line break or end of the text, and a CR not followed by LF is dropped
// (stray_cr, pushed as met). Returns [value, end, added, pos, lines]: `added` the
// characters kept (a dropped CR counts none), `pos` past the delimiter, `lines` the line
// breaks consumed (0 or 1: the field ends at the first one).
function scanUnquoted(text, len, start, init, recordLine, recordRow, errors) {
  let value = init;
  let added = 0;
  let p = start;
  let seg = start;
  for (;;) {
    const comma = text.indexOf(',', p);
    const lf = text.indexOf('\n', p);
    const cr = text.indexOf('\r', p);
    let end = -1;
    let kind = END;
    if (comma !== -1) {
      end = comma;
      kind = COMMA;
    }
    if (lf !== -1 && (end === -1 || lf < end)) {
      end = lf;
      kind = BREAK;
    }
    if (cr !== -1 && (end === -1 || cr < end)) {
      end = cr;
      kind = 3;
    }
    if (end === -1) {
      if (seg < len) {
        value += text.slice(seg, len);
        added += len - seg;
      }
      return [value, END, added, len, 0];
    }
    if (kind === 3) {
      if (text.charCodeAt(end + 1) === 10) {
        if (seg < end) {
          value += text.slice(seg, end);
          added += end - seg;
        }
        return [value, BREAK, added, end + 2, 1];
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (seg < end) {
        value += text.slice(seg, end);
        added += end - seg;
      }
      p = end + 1;
      seg = end + 1;
      continue;
    }
    if (seg < end) {
      value += text.slice(seg, end);
      added += end - seg;
    }
    if (kind === COMMA) return [value, COMMA, added, end + 1, 0];
    return [value, BREAK, added, end + 1, 1];
  }
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  // One scan each for the whole file, so a file with no quote (or no CR) at all never
  // pays a scan-to-EOF per record for it.
  const fileHasQuote = text.indexOf('"') !== -1;
  const fileHasCR = text.indexOf('\r') !== -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0; // the next character to read
  let line = 1; // the line that character is on

  while (pos < len) {
    // Lines with no characters are no records.
    for (;;) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
      if (pos >= len) break;
    }
    if (pos >= len) break;

    // The record being read: the line it starts on and the index in rows it takes (null: the header).
    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // The first physical line of the record: to its LF, or to the end of the text.
    let lineEnd = text.indexOf('\n', pos);
    const hasLF = lineEnd !== -1;
    if (!hasLF) lineEnd = len;
    // A CR just before that LF is the CRLF's, not content.
    let segEnd = lineEnd;
    if (hasLF && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) segEnd = lineEnd - 1;
    // The line's content, sliced once: the quote and stray-CR checks run on it, so
    // they never scan past the line (a file with no CR at all would otherwise pay a
    // scan to the end of the file per record), and the split below reuses it.
    const lineStr = text.slice(pos, segEnd);
    // A quote anywhere on the line, or a CR that is not the CRLF's: the split below
    // A quote anywhere on the line, or a CR that is not the CRLF's, rules out the split.
    const hasQuote = fileHasQuote && lineStr.indexOf('"') !== -1;
    const hasStrayCR = fileHasCR && lineStr.indexOf('\r') !== -1;

    let fields;
    let quoted;
    if (!hasQuote && !hasStrayCR) {
      // No quote, no stray CR: the whole line splits at its commas.
      fields = lineStr.split(',');
      quoted = false;
      if (hasLF) {
        pos = lineEnd + 1;
        line += 1;
      } else {
        pos = len;
      }
    } else {
      // The general path: field by field, over the line extent cached for the line the
      // field sits on (lineEnd its LF, segEnd its end without the CRLF's CR).
      fields = [];
      let curLineEnd = lineEnd;
      let curSegEnd = segEnd;
      let curHasStrayCR = hasStrayCR;
      let recEnd = false;
      while (!recEnd) {
        if (text.charCodeAt(pos) === 34) {
          // A field that opens with a quote.
          quoted = true;
          const open = pos;
          const contentStart = pos + 1;
          let p = contentStart;
          let parts = null; // segments around doubled quotes, joined at the end
          let closeQ = -1;
          for (;;) {
            const q = text.indexOf('"', p);
            if (q === -1) break;
            if (text.charCodeAt(q + 1) === 34) {
              if (parts === null) parts = [text.slice(contentStart, q), '"'];
              else parts.push(text.slice(p, q), '"');
              p = q + 2;
              continue;
            }
            closeQ = q;
            break;
          }
          if (closeQ === -1) {
            // The quote never closes: it is a literal character, and the text after it
            // is read again as unquoted. (No line break counted yet: the failed scan
            // counted none, as the reference resets its line before the re-read.)
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            const r = scanUnquoted(text, len, open + 1, '"', recordLine, recordRow, errors);
            fields.push(r[0]);
            pos = r[3];
            line += r[4];
            if (r[1] !== COMMA) recEnd = true;
            continue;
          }
          // The field's value, before the CRs inside it are read as LFs.
          let value =
            parts === null
              ? text.slice(contentStart, closeQ)
              : (parts.push(text.slice(p, closeQ)), parts.join(''));
          // Line breaks inside the quotes: each LF, and each CR not already paired
          // with an LF, counts once. The LF count scans the big text, but only to the
          // next LF past the closing quote, which is close by; the CR counts run on
          // the (short) value, so they never scan past it.
          let nLF = 0;
          let i = contentStart;
          for (;;) {
            const f = text.indexOf('\n', i);
            if (f === -1 || f >= closeQ) break;
            nLF += 1;
            i = f + 1;
          }
          let breaks = nLF;
          if (value.indexOf('\r') !== -1) {
            let nCR = 0;
            let j = 0;
            for (;;) {
              const f = value.indexOf('\r', j);
              if (f === -1) break;
              nCR += 1;
              j = f + 1;
            }
            let nCRLF = 0;
            j = 0;
            for (;;) {
              const f = value.indexOf('\r\n', j);
              if (f === -1) break;
              nCRLF += 1;
              j = f + 2;
            }
            breaks = nLF + nCR - nCRLF;
            value = value.replace(CR_RE, '\n');
          }
          line += breaks;
          // What follows the closing quote.
          const after = closeQ + 1;
          if (after >= len) {
            fields.push(value);
            pos = len;
            recEnd = true;
            continue;
          }
          const nc = text.charCodeAt(after);
          if (nc === 44) {
            fields.push(value);
            pos = after + 1;
          } else if (nc === 10) {
            fields.push(value);
            pos = after + 1;
            line += 1;
            recEnd = true;
            continue;
          } else if (nc === 13 && text.charCodeAt(after + 1) === 10) {
            fields.push(value);
            pos = after + 2;
            line += 1;
            recEnd = true;
            continue;
          } else {
            // What follows the closing quote is appended as it stands, up to the next
            // comma or line break (quote_junk, when the field ends).
            const r = scanUnquoted(text, len, after, value, recordLine, recordRow, errors);
            if (r[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            fields.push(r[0]);
            pos = r[3];
            line += r[4];
            if (r[1] !== COMMA) {
              recEnd = true;
              continue;
            }
          }
          // The record goes on: if the quoted field spanned lines, the line the next
          // field sits on is a later one, so its extent is found again.
          if (breaks > 0) {
            let le = text.indexOf('\n', pos);
            const hasLF2 = le !== -1;
            if (!hasLF2) le = len;
            curLineEnd = le;
            curSegEnd = hasLF2 && le > pos && text.charCodeAt(le - 1) === 13 ? le - 1 : le;
            curHasStrayCR = false;
            if (fileHasCR) {
              const cr2 = text.indexOf('\r', pos);
              curHasStrayCR = cr2 !== -1 && cr2 < curSegEnd;
            }
          }
          continue;
        }
        // An unquoted field: to the next comma on its line, else to its line's end.
        quoted = false;
        const comma = text.indexOf(',', pos);
        if (comma !== -1 && comma < curLineEnd) {
          if (curHasStrayCR) {
            const cr = text.indexOf('\r', pos);
            if (cr !== -1 && cr < comma) {
              const r = scanUnquoted(text, len, pos, '', recordLine, recordRow, errors);
              fields.push(r[0]);
              pos = r[3];
              line += r[4];
              if (r[1] !== COMMA) recEnd = true;
              continue;
            }
          }
          fields.push(text.slice(pos, comma));
          pos = comma + 1;
          continue;
        }
        if (curHasStrayCR) {
          const cr = text.indexOf('\r', pos);
          if (cr !== -1 && cr < curSegEnd) {
            const r = scanUnquoted(text, len, pos, '', recordLine, recordRow, errors);
            fields.push(r[0]);
            pos = r[3];
            line += r[4];
            if (r[1] !== COMMA) recEnd = true;
            continue;
          }
        }
        fields.push(text.slice(pos, curSegEnd));
        if (curLineEnd < len) {
          pos = curLineEnd + 1;
          line += 1;
        } else {
          pos = len;
        }
        recEnd = true;
      }
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
