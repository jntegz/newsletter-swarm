import { describe, expect, it } from 'vitest';
import { csvCell, csvLayout, csvLine, detectSeparator, parseCsv, parseCsvChunk } from '../src/csv';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('parseCsv', () => {
  it('parses plain rows with LF, CRLF and bare CR endings', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\r1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles quotes, escaped quotes, separators and newlines inside quotes', () => {
    expect(parseCsv('"Lovelace, Ada","say ""hi""","line\r\nbreak"\n')).toEqual([
      ['Lovelace, Ada', 'say "hi"', 'line\r\nbreak'],
    ]);
    expect(parseCsv('"",x,""""\n')).toEqual([['', 'x', '"']]);
  });

  it('keeps empty fields and skips blank lines', () => {
    expect(parseCsv('a,,c,\n\n\r\n1,2,3,4')).toEqual([
      ['a', '', 'c', ''],
      ['1', '2', '3', '4'],
    ]);
  });

  it('strips a byte order mark and decodes UTF-8', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('name\nZoë 🐝\n')]);
    expect(parseCsv(withBom)).toEqual([['name'], ['Zoë 🐝']]);
  });

  it('closes a quote left open at the end of the file', () => {
    expect(parseCsv('a,"unterminated\nstill')).toEqual([['a', 'unterminated\nstill']]);
  });

  it('keeps stray quotes inside unquoted fields', () => {
    expect(parseCsv('ab"c,d\n')).toEqual([['ab"c', 'd']]);
  });

  it('detects semicolon and tab separators', () => {
    expect(detectSeparator(bytes('a;b;c\n1,5;2;3'))).toBe(';');
    expect(detectSeparator(bytes('a\tb\n'))).toBe('\t');
    expect(detectSeparator(bytes('"a;b",c\n'))).toBe(',');
    expect(parseCsv('email;name\nx@y.z;"A; B"\n')).toEqual([
      ['email', 'name'],
      ['x@y.z', 'A; B'],
    ]);
  });
});

describe('parseCsvChunk', () => {
  it('leaves an incomplete trailing record for the next chunk', () => {
    const data = bytes('a,b\n1,"two\nlines"\n3,4');
    const chunk = parseCsvChunk(data, { final: false });
    expect(chunk.rows).toEqual([
      ['a', 'b'],
      ['1', 'two\nlines'],
    ]);
    expect(chunk.consumed).toBe(data.length - 3);
    expect(parseCsvChunk(data.subarray(chunk.consumed), { final: true }).rows).toEqual([
      ['3', '4'],
    ]);
  });

  it('never splits a quoted newline, an escaped quote or a CRLF across chunks', () => {
    const text = 'x,"a\r\nb"\r\n"say ""hi""",y\r\nlast,row\r\n';
    const data = bytes(text);
    // Feed every possible split point: the rows always come out the same.
    for (let cut = 1; cut < data.length; cut++) {
      const firstPart = parseCsvChunk(data.subarray(0, cut), { final: false });
      const rest = parseCsvChunk(data.subarray(firstPart.consumed), { final: true });
      expect([...firstPart.rows, ...rest.rows]).toEqual([
        ['x', 'a\r\nb'],
        ['say "hi"', 'y'],
        ['last', 'row'],
      ]);
    }
  });

  it('resumes from byte offsets inside multi-byte text', () => {
    const data = bytes('name\nÅsa\nZoë\n日本\n');
    const rows: string[][] = [];
    let offset = 0;
    let length = 3; // smaller than most rows, so reads often end mid-character
    while (offset < data.length) {
      const end = Math.min(data.length, offset + length);
      const chunk = parseCsvChunk(data.subarray(offset, end), { final: end === data.length });
      if (chunk.consumed === 0) {
        length *= 2; // what the importer does: read more and try again
        continue;
      }
      rows.push(...chunk.rows);
      offset += chunk.consumed;
      length = 3;
    }
    expect(rows.flat()).toEqual(['name', 'Åsa', 'Zoë', '日本']);
  });

  it('stops after `limit` records', () => {
    const data = bytes('1\n2\n3\n');
    const chunk = parseCsvChunk(data, { final: true, limit: 2 });
    expect(chunk.rows).toEqual([['1'], ['2']]);
    expect(chunk.consumed).toBe(4);
  });
});

describe('csvLayout', () => {
  it('reads the header row and where data starts', () => {
    const data = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...bytes('Email,Name,,Name\nada@example.com,Ada,x,y\n'),
    ]);
    const layout = csvLayout(data, true);
    expect(layout).toMatchObject({
      separator: ',',
      headerless: false,
      columns: ['Email', 'Name', 'Column 3', 'Name (2)'],
    });
    expect(new TextDecoder().decode(data.subarray(layout!.dataOffset))).toBe(
      'ada@example.com,Ada,x,y\n',
    );
  });

  it('treats a first row holding an address as data', () => {
    const layout = csvLayout(bytes('ada@example.com;Ada\n'), true);
    expect(layout).toMatchObject({ headerless: true, dataOffset: 0, separator: ';' });
    expect(layout!.columns).toEqual(['Column 1', 'Column 2']);
  });

  it('needs a complete first row', () => {
    expect(csvLayout(bytes('email,na'), false)).toBeNull();
    expect(csvLayout(bytes(''), true)).toBeNull();
  });
});

describe('writing', () => {
  it('quotes when needed and neutralises spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell(null)).toBe('');
    expect(csvLine(['a', 1, true, null])).toBe('a,1,true,\r\n');
  });

  it('round-trips through the parser', () => {
    const cells = ['Lovelace, Ada', 'line\nbreak', '"quoted"', 'Zoë'];
    expect(parseCsv(csvLine(cells))).toEqual([cells]);
  });
});
