// A small RFC 4180 reader for setup uploads: quoted fields, doubled quotes,
// CRLF or LF, a leading BOM. The delimiter is whichever of , ; or tab the
// header line uses most, since European exports often use ;.

export interface CsvTable {
  delimiter: string;
  headers: string[];
  /** Data rows, each with its 1-based line number in the file (the header is line 1). */
  rows: Array<{ line: number; cells: string[] }>;
}

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]?.[1] ? counts[0][0] : ",";
}

export function parseCsv(input: string): CsvTable {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const records: Array<{ line: number; cells: string[] }> = [];

  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  const endCell = () => {
    cells.push(cell);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    // Skip blank lines (a lone empty cell).
    if (cells.length > 1 || cells[0] !== "") records.push({ line: recordLine, cells });
    cells = [];
    recordLine = line;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      line++;
      endRecord();
    } else cell += ch;
  }
  if (cell !== "" || cells.length > 0) endRecord();

  const [header, ...rows] = records;
  return { delimiter, headers: (header?.cells ?? []).map((h) => h.trim()), rows };
}
