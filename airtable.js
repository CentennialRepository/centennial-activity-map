
import { URLSearchParams } from 'url';
const AIRTABLE_API = 'https://api.airtable.com/v0';

export async function fetchAllRecords({ baseId, tableName, apiKey, viewName = '', fields = [], extraParams = {} }) {
  const headers = { 'Authorization': `Bearer ${apiKey}` };
  const records = [];
  let offset = null;

  do {
    const params = new URLSearchParams();
    params.set('pageSize', '100');
    if (viewName) params.set('view', viewName);
    if (fields && fields.length) for (const f of fields) params.append('fields[]', f);
    if (offset) params.set('offset', offset);
    for (const [k, v] of Object.entries(extraParams || {})) if (v != null && v !== '') params.set(k, v);

    const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableName)}?${params.toString()}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Airtable fetch failed: ${res.status} ${res.statusText} - ${await res.text()}`);
    const json = await res.json();
    if (json.records?.length) records.push(...json.records);
    offset = json.offset || null;
  } while (offset);

  return records;
}
