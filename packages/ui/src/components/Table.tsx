import type { ReactNode } from 'react';
import { ErrorNotice, Skeleton } from './Feedback';

export interface TableColumn<Row> {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Numbers align right and use tabular figures. */
  align?: 'left' | 'right';
  /** The column that names the row; rendered as a row header for screen readers. */
  rowHeader?: boolean;
}

interface TableProps<Row> {
  /** Describes the table for screen readers (visually hidden). */
  caption: string;
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[] | undefined;
  rowKey: (row: Row) => string;
  loading?: boolean;
  /** Shown instead of the rows when there is a problem loading them. */
  error?: string | null | undefined;
  /** Shown when there are no rows. */
  empty?: ReactNode;
  /** Minimum width before the table scrolls sideways, e.g. 'min-w-[640px]'. */
  minWidth?: string;
}

/**
 * A data table: sentence-case headers (`.table-head`, from the dashboard theme), 13px rows and
 * hairline separators. It scrolls sideways inside its card on narrow screens rather than squeezing
 * columns, and its screen-reader-only text stays inside that box.
 */
export function Table<Row>({
  caption,
  columns,
  rows,
  rowKey,
  loading = false,
  error,
  empty = 'Nothing here yet.',
  minWidth = 'min-w-[560px]',
}: TableProps<Row>) {
  if (error) return <ErrorNotice message={error} />;
  const align = (column: TableColumn<Row>) =>
    column.align === 'right' ? 'tabular text-right' : 'text-left';
  const pad = (index: number) =>
    index === 0 ? 'pl-5 pr-3' : index === columns.length - 1 ? 'pl-3 pr-5' : 'px-3';
  return (
    <div className="relative overflow-x-auto">
      <table className={`w-full ${minWidth} text-[13px]`} aria-busy={loading || undefined}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="table-head">
            {columns.map((column, i) => (
              <th
                key={column.key}
                scope="col"
                className={`${pad(i)} py-2.5 font-semibold ${align(column)}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 3 }, (_, r) => (
              <tr key={r} className="border-t border-line">
                {columns.map((column, i) => (
                  <td key={column.key} className={`${pad(i)} py-3`}>
                    <Skeleton className="h-4" />
                  </td>
                ))}
              </tr>
            ))
          ) : !rows || rows.length === 0 ? (
            <tr className="border-t border-line">
              <td colSpan={columns.length} className="px-5 py-8 text-center text-[13px] text-sub">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className="border-t border-line hover:bg-surface-alt">
                {columns.map((column, i) =>
                  column.rowHeader ? (
                    <th
                      key={column.key}
                      scope="row"
                      className={`${pad(i)} py-3 font-normal ${align(column)}`}
                    >
                      {column.cell(row)}
                    </th>
                  ) : (
                    <td key={column.key} className={`${pad(i)} py-3 ${align(column)}`}>
                      {column.cell(row)}
                    </td>
                  ),
                )}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {loading && (
        <p role="status" className="sr-only">
          Loading {caption}
        </p>
      )}
    </div>
  );
}
