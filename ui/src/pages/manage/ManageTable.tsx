/**
 * The Manage chrome (redesign R7): the one small table every section draws
 * with, the section header every section starts under, and the mono section
 * label the design uses above a block.
 *
 * The table is presentational on purpose — a section owns the reading and
 * hands it cells. At desktop it sits in the design's one card (review
 * 15-1280-2): 1px `line`, radius 12, white, 16px inner side padding, the
 * header row printed inside the frame. Below 640px the same row cannot be a
 * row any more (five columns of 13.5px text at 390px is unreadable, and
 * CONTRACT forbids horizontal page scroll), so the row mounts as a stacked
 * card that prints `LABEL value` lines — its own card already, so it does
 * not sit inside the table's one. Which layout mounts is a `matchMedia`
 * question, exactly like the Shell's phone frame (`components/Shell.tsx`):
 * a table that only gets `display:none` is still a table in the
 * accessibility tree.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useMediaQuery } from "../../components/Shell";

/** The width a table stops being a table (the app's own 640px split). */
export const TABLE_STACK_QUERY = "(max-width: 639.98px)";

/** Does the viewport want stacked rows instead of a table? */
export function useIsStackedTable(): boolean {
  return useMediaQuery(TABLE_STACK_QUERY);
}

export interface ManageColumn {
  key: string;
  /** The word printed in the header cell and, on a stacked row, before the value. */
  label: string;
  className?: string;
}

export interface ManageRow {
  id: string;
  cells: Record<string, ReactNode>;
  /** When set, the first cell is a link to here (the row's own address). */
  href?: string;
}

export interface ManageTableProps {
  columns: ManageColumn[];
  rows: ManageRow[];
  /** The plain sentence when there are no rows. */
  empty: string;
  testid: string;
}

const HEADER_CELL =
  "pt-[8px] pr-3 pb-[8px] pl-0 border-b border-line text-left font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted whitespace-nowrap";
const BODY_CELL = "pt-[11px] pr-3 pb-[11px] pl-0 text-[13.5px] align-top";
const STACK_CARD = "mb-[8px] rounded-[10px] border border-line bg-surface p-[12px] last:mb-0";
const STACK_LINE = "flex items-baseline gap-[8px] py-[2px] text-[13.5px]";
const STACK_LABEL =
  "shrink-0 font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-faint";
/** A long mono name (a worker's pod name) breaks anywhere rather than
 * orphaning a tail outside the card (review 15-390-3). */
const STACK_VALUE = "min-w-0 [overflow-wrap:anywhere]";

const NAME_LINK =
  "text-ink underline decoration-line-strong underline-offset-2 hover:text-accent-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

export function ManageTable({ columns, rows, empty, testid }: ManageTableProps) {
  if (rows.length === 0) {
    return (
      <p className="text-[13.5px] text-muted" data-testid={`${testid}-empty`}>
        {empty}
      </p>
    );
  }
  return <ManageRows columns={columns} rows={rows} testid={testid} />;
}

function ManageRows({
  columns,
  rows,
  testid,
}: {
  columns: ManageColumn[];
  rows: ManageRow[];
  testid: string;
}) {
  // The first column is the row's name, so it is the cell that carries the
  // row's link; the other cells print their value as given.
  const firstKey = columns[0]?.key ?? "";
  const stacked = useIsStackedTable();
  if (stacked) {
    return (
      <div data-testid={testid} data-layout="stacked">
        {rows.map((row) => (
          <div key={row.id} className={STACK_CARD} data-testid={`${testid}-row-${row.id}`}>
            {columns.map((column, index) => (
              <div key={column.key} className={STACK_LINE}>
                <span className={STACK_LABEL}>{column.label}</span>
                <span className={`${STACK_VALUE} ${index === 0 ? "font-semibold" : ""}`}>
                  {cellContent(row, column, firstKey, testid)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      data-testid={`${testid}-card`}
      className="overflow-hidden rounded-[12px] border border-line bg-surface"
    >
      <div className="px-[16px]">
        <table
          className="w-full border-collapse [&>tbody>tr:last-child>td]:border-b-0"
          data-testid={testid}
          data-layout="table"
        >
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`${HEADER_CELL} ${column.className ?? ""}`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid={`${testid}-row-${row.id}`}>
                {columns.map((column, index) => (
                  <td
                    key={column.key}
                    className={`${BODY_CELL} border-b border-line-soft ${
                      index === 0 ? "font-semibold " : ""
                    }${column.className ?? ""}`}
                  >
                    {cellContent(row, column, firstKey, testid)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The row's value for one column: the first cell carries the row's link. */
function cellContent(
  row: ManageRow,
  column: ManageColumn,
  firstKey: string,
  testid: string,
): ReactNode {
  const value = row.cells[column.key];
  if (!row.href || column.key !== firstKey) return value;
  return (
    <Link to={row.href} className={NAME_LINK} data-testid={`${testid}-row-${row.id}-link`}>
      {value}
    </Link>
  );
}

/** The header every section starts with: the name, one honest sentence, and
 * at the right the section's one primary action. */
export function SectionHeader({
  title,
  blurb,
  action,
  testid,
}: {
  title: string;
  blurb: string;
  action?: ReactNode;
  testid?: string;
}) {
  return (
    <header className="flex flex-wrap items-end gap-x-4 gap-y-[10px]" data-testid={testid}>
      <div className="flex min-w-0 flex-col gap-[4px]">
        <h2 className="text-[20px] font-bold leading-[1.25]">{title}</h2>
        <p className="text-[13.5px] text-muted">{blurb}</p>
      </div>
      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </header>
  );
}

/** The redesign's primary action: accent fill, radius 8, 34px — never the old
 * hard-offset-shadow `ds` button. */
export const SECTION_ACTION_CLASS =
  "inline-flex h-[34px] cursor-pointer items-center gap-[6px] rounded-[8px] bg-accent px-[12px] text-[13px] font-semibold text-white no-underline hover:bg-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-fg";

/** The label above a block (CONTRACT: mono 10.5/600, uppercase, .06em, muted). */
export function SectionLabel({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <p
      className="mb-[8px] font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted"
      data-testid={testid}
    >
      {children}
    </p>
  );
}
