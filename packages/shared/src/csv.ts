import { sanitizeCsvCell } from "./files";

export type CsvCell = string | number | bigint | boolean | Date | null | undefined;

export function buildCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => row.map((cell) => escapeCsvCell(cellToString(cell))).join(","))
  ].join("\r\n");
}

function cellToString(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString();
  return String(cell);
}

function escapeCsvCell(value: CsvCell): string {
  const sanitized = sanitizeCsvCell(cellToString(value));
  return /[",\r\n]/.test(sanitized) ? `"${sanitized.replace(/"/g, '""')}"` : sanitized;
}
