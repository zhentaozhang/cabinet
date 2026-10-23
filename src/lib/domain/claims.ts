/**
 * The claims table.
 *
 * A draft that cites sources still has to say *which sentence* each source
 * supports. The model writes that mapping as a table; we only check its shape —
 * that every row names a real, persisted evidence id. Whether the quote really
 * supports the claim is a judgement call, and it stays with the human.
 */

export type ClaimRow = {
  /** The claim, as written in the draft. */
  claim: string;
  /** Evidence ids cited by this row, in the order they appear. */
  refs: string[];
  /** Whatever the model wrote in the third column; the human fills this in. */
  supported: string;
};

export type ClaimsTable = {
  rows: ClaimRow[];
  /** Rows whose citation does not resolve to a persisted evidence row. */
  dangling: string[];
  /** Rows that cite nothing at all. */
  uncited: number;
};

const CITE = /\[cite:(evd_[A-Za-z0-9_-]+)\]/g;
const BARE_ID = /\bevd_[A-Za-z0-9_-]+\b/g;

function cellText(cell: string): string {
  return cell.trim().replace(/\s+/g, " ");
}

/** Ids cited in a cell, from either `[cite:evd_x]` or a bare `evd_x`. */
export function refsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(CITE)) found.add(match[1]);
  for (const match of text.matchAll(BARE_ID)) found.add(match[0]);
  return [...found];
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

function isSeparator(line: string): boolean {
  return /^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes("-");
}

/**
 * Find the claims table: the first markdown table whose header mentions both a
 * claim column and a source column. Header wording is matched loosely because
 * the model is free to write 主张/观点/结论 and 引用/来源/证据.
 */
export function parseClaimsTable(markdown: string): ClaimsTable {
  const lines = markdown.split(/\r?\n/);
  let rows: ClaimRow[] = [];
  const dangling: string[] = [];
  let uncited = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (!isTableRow(lines[index])) continue;
    const header = lines[index];
    const looksLikeClaims =
      /主张|观点|结论|claim/i.test(header) && /引用|来源|证据|cite|evidence/i.test(header);
    if (!looksLikeClaims) continue;

    // Consume the rest of this table.
    const body: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && isTableRow(lines[cursor])) {
      if (!isSeparator(lines[cursor])) body.push(lines[cursor]);
      cursor += 1;
    }

    rows = body.map((line) => {
      const cells = line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map(cellText);
      const refs = refsIn(cells.slice(1).join(" "));
      if (refs.length === 0) uncited += 1;
      return { claim: cells[0] ?? "", refs, supported: cells[2] ?? "" };
    });
    index = cursor - 1;
    break;
  }

  return { rows, dangling: [...dangling], uncited };
}

export type ClaimsCheck = {
  /** Shape is acceptable: enough rows, every row cites something real. */
  ok: boolean;
  rows: ClaimRow[];
  /** Cited ids that are not among this run's persisted evidence. */
  dangling: string[];
  /** What is wrong, in words a person can act on. */
  problems: string[];
};

export function checkClaimsTable(
  content: string,
  evidenceIds: Set<string> | undefined,
  minRows: number,
): ClaimsCheck {
  const table = parseClaimsTable(content);
  const problems: string[] = [];

  if (table.rows.length === 0) {
    problems.push("没有找到「主张—来源」表");
  } else if (table.rows.length < minRows) {
    problems.push(`主张—来源表只有 ${table.rows.length} 行，要求至少 ${minRows} 行`);
  }

  const dangling = new Set<string>();
  for (const row of table.rows) {
    if (row.refs.length === 0) {
      problems.push(`有一行主张没有引用任何证据：「${row.claim.slice(0, 24)}」`);
      continue;
    }
    // Without an evidence set we cannot resolve ids; the caller decides whether
    // that matters (a hand-written submission has no run at all).
    if (!evidenceIds) continue;
    for (const ref of row.refs) {
      if (!evidenceIds.has(ref)) dangling.add(ref);
    }
  }

  const danglingList = [...dangling];
  if (danglingList.length > 0) {
    problems.push(
      `引用了不存在的证据：${danglingList.slice(0, 3).join("、")}${
        danglingList.length > 3 ? ` 等 ${danglingList.length} 个` : ""
      }`,
    );
  }

  return {
    ok: problems.length === 0,
    rows: table.rows,
    dangling: danglingList,
    problems,
  };
}
