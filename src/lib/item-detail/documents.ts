// How the item page names the documents an item carries.
//
// A document is agent context — a plan, a log, a progress page — and the
// board never shows one. The item page owes the reader only the fact that it
// exists and how big it is, in one plain line each: "notes: 12 entries,
// 9 KB". Nothing here reads a value, and the server sends none
// (`get_item_detail`'s `documents`).

/** One document's summary, as `GET /api/items/{id}/detail` reports it. */
export interface DetailDocument {
  readonly doc: string;
  readonly entries: number;
  /** UTF-8 bytes of the stored values, summed. */
  readonly bytes: number;
}

/**
 * A size a person can read at a glance.
 *
 * Decimal units (1 KB is 1,000 bytes), so a 9,000-byte document reads as
 * "9 KB" rather than "8.8 KB". Whole kilobytes from 10 KB up, one decimal
 * below it where the decimal still says something, and the decimal dropped
 * when it would be ".0".
 */
export function formatDocumentSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1_000_000) {
    const kilobytes = bytes / 1000;
    return `${kilobytes < 10 ? trimmed(kilobytes) : Math.round(kilobytes)} KB`;
  }
  return `${trimmed(bytes / 1_000_000)} MB`;
}

function trimmed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

/** The one line for a document: `notes: 12 entries, 9 KB`. */
export function documentLine(document: DetailDocument): string {
  const noun = document.entries === 1 ? "entry" : "entries";
  return `${document.doc}: ${document.entries} ${noun}, ${formatDocumentSize(document.bytes)}`;
}
