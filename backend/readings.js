// readings.js — "this Sunday's readings" when Boon gives no references.
// The lectionary itself is not stored; the references are found by web search and checked by reading them back out of
// the results. The words of each reading then come from the stored Bible (bible.js), never from the search results
// and never from a model.
import { tavilySearch } from './web.js';
import { askModel } from './ai/cascade.js';
import { parseJson, clip } from './util.js';
import { extractRefs } from './bible.js';

export async function findReadings(request) {
  // one search tends to find only part of the set (often just the Old Testament reading and the psalm), so ask three ways
  const found = (await Promise.all([
    tavilySearch(`${request} Revised Common Lectionary readings`),
    tavilySearch(`${request} lectionary Gospel and Epistle reading`),
    tavilySearch(`Revised Common Lectionary ${request} first reading psalm second reading gospel`),
  ])).filter(Boolean);
  const web = [...new Set(found)].join('\n\n');
  if (!web) return { refs: [], note: 'The lectionary readings could not be looked up just now, because web search was unavailable.' };
  const raw = await askModel(`Below are web search results. Find the Revised Common Lectionary readings for the Sunday meant in this request: "${request}".

Reply with ONLY JSON: {"occasion":"the name and year, for example Proper 22, Year A","readings":["first reading reference","psalm reference","second reading reference","gospel reference"]}
Rules: use only references that appear in the results; write each as book chapter:verses (for example Matthew 21:33-46; a psalm may be a chapter alone, such as Psalm 80); if two tracks are shown (semi-continuous and complementary) include both first readings and both psalms; if the results do not show the readings, return an empty list.

${clip(web, 9000)}`, { role: 'quick', timeoutMs: 25000 });
  const j = parseJson(raw);
  const seen = new Set(), refs = [];
  for (const s of Array.isArray(j.readings) ? j.readings : []) {
    for (const r of extractRefs(String(s), { chapterOnlyOk: true })) if (!seen.has(r.label)) { seen.add(r.label); refs.push(r.text); }
  }
  const few = refs.length > 0 && refs.length < 4;
  return { refs: refs.slice(0, 8), partial: few, occasion: String(j.occasion || '').slice(0, 80), note: refs.length ? `References found by web search${j.occasion ? ' for ' + String(j.occasion).slice(0, 80) : ''}; check them against your own lectionary.${few ? ` Only ${refs.length} reading${refs.length === 1 ? ' was' : 's were'} found, whereas a Sunday usually has four (first reading, psalm, second reading, Gospel): ask for any missing one by its reference.` : ''}` : 'The search results did not show the readings.' };
}
