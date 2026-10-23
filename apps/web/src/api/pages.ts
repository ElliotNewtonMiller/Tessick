/**
 * Every item of a paged list (lists that grow are paged: `limit` and `cursor` in, `next_cursor`
 * out; docs/rfc_03_api_and_xml_contracts.md §1.1), following `next_cursor` to the last page.
 * Null when a page fails, which callers treat like a failed request.
 */
export async function fetchAllPages<T>(url: (cursor?: string) => string, key: string, init: RequestInit): Promise<T[] | null> {
  const items: T[] = [];
  let cursor: string | undefined;
  // A bound, in case a server ever answered the same cursor forever.
  for (let page = 0; page < 1000; page++) {
    const res = await fetch(url(cursor), init);
    if (!res.ok) return null;
    const data = await res.json();
    items.push(...((data[key] as T[] | undefined) ?? []));
    if (!data.next_cursor) return items;
    cursor = data.next_cursor;
  }
  return items;
}
