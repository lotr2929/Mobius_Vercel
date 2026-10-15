// pcm/contentq.js - is this a question about what one of Boon's own documents says?
// "What does my 2002 paper say about turf?" is answered from the document's stored text. The planner used to read "my 2002 paper" as a
// request to FIND that file in Google Drive (and to search the web as well), so such questions were never answered from the document.
// A request to locate, open, list, link or sync something is not a content question, whatever it mentions.

const DOC = '(?:paper|article|thesis|dissertation|chapter|book|document|file|report|manuscript|essay|draft|notes?|manifesto|outline)';
const SAYS = /\b(?:say|says|said|argue|argues|argued|define|defines|defined|give|gives|gave|state|states|stated|mention|mentions|mentioned|claim|claims|conclude|concludes|describe|describes|described|suggest|suggests|suggested|propose|proposes|proposed|report|reports|reported|find|finds|found|recommend|recommends|use|uses|used|cover|covers|explain|explains|discuss|discusses|list|lists|identify|identifies|specify|specifies|include|includes|note|notes|noted|show|shows|measure|measures)\b/i;
const ABOUT_DOC = new RegExp(`\\b(?:my|our|the|this|that|his|her)\\b[^.?!]{0,60}\\b${DOC}\\b|\\b${DOC}\\b[^.?!]{0,20}\\b(?:by|from)\\b`, 'i');
const ACCORDING = new RegExp(`\\b(?:according to|in|from|per)\\s+(?:my|our|the|this|that)\\b[^.?!]{0,60}\\b${DOC}\\b`, 'i');
const LOCATE = /\b(?:where(?:'s| is| are| did)|find (?:me )?(?:the |my )?(?:file|folder|paper|document)|locate|open (?:the |my )?(?:file|folder|paper|document)|list (?:the )?(?:files|folders)|show me (?:the )?(?:file|folder)|which folder|link (?:this|the|my)|sync|upload|download|what(?:'s| is) in (?:the |my )?folder|what folders|numbered list)\b/i;

export function isContentQuestion(query) {
  const q = String(query || '');
  if (!q.trim() || LOCATE.test(q)) return false;
  return (ACCORDING.test(q) || ABOUT_DOC.test(q)) && SAYS.test(q) && /[?]|^\s*(?:what|how|which|who|why|when|where|does|do|did|is|are|according|in)\b/i.test(q);
}