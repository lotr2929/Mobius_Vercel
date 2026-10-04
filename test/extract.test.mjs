
// test/extract.test.mjs — every file type Mobius claims to read is built in memory and read back.
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { extractFromBuffer, htmlToText, decodeEntities } from '../backend/docs/extract.js';

const zipOf = async files => { const z = new JSZip(); for (const [p, c] of Object.entries(files)) z.file(p, c); return z.generateAsync({ type: 'nodebuffer' }); };

test('html: tags, scripts and entities', () => {
  const t = htmlToText('<html><head><title>x</title></head><body><script>var a=1</script><h1>Grace &amp; Faith</h1><p>First&nbsp;para.</p><p>Second<br>line</p></body></html>');
  assert.match(t, /Grace & Faith/);
  assert.match(t, /First para\./);
  assert.doesNotMatch(t, /var a|<|title/);
  assert.equal(decodeEntities('&#8212;&#x2019;&mdash;'), '—’—');
});

test('epub: follows the spine order, not file order', async () => {
  const buf = await zipOf({
    'mimetype': 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OEBPS/content.opf': '<package><metadata><dc:title>A Small Book</dc:title></metadata><manifest><item id="a" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="b" href="text/ch2.xhtml" media-type="application/xhtml+xml"/><item id="c" href="style.css" media-type="text/css"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
    'OEBPS/ch1.xhtml': '<html><body><p>Chapter one is about grace and the first things.</p></body></html>',
    'OEBPS/text/ch2.xhtml': '<html><body><p>Chapter two opens the book, by the spine, before chapter one.</p></body></html>',
  });
  const t = await extractFromBuffer(buf, 'book.epub');
  assert.match(t, /^A Small Book/);
  assert.ok(t.indexOf('Chapter two') < t.indexOf('Chapter one'), 'spine order must win');
});

test('xlsx: sheet names, shared strings, numbers, gaps', async () => {
  const buf = await zipOf({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Item</t></si><si><t>Cost</t></si><si><t>Coffee</t></si><si><r><t>Tea </t></r><r><t>bags</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>4.5</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" t="b"><v>1</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a note</t></is></c></row></sheetData></worksheet>',
  });
  const t = await extractFromBuffer(buf, 'b.xlsx');
  assert.match(t, /## Sheet: Budget\nItem\t\tCost\nCoffee\t\t4\.5\nTea bags\tTRUE/);
  assert.match(t, /## Sheet: Notes & more\na note/);
});

test('pptx: slides in numeric order with speaker notes', async () => {
  const slide = text => `<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
  const buf = await zipOf({
    'ppt/slides/slide10.xml': slide('Tenth'), 'ppt/slides/slide2.xml': slide('Second'), 'ppt/slides/slide1.xml': slide('First'),
    'ppt/notesSlides/notesSlide2.xml': '<p:notes><a:p><a:r><a:t>Say this aloud</a:t></a:r></a:p><a:p><a:r><a:t>2</a:t></a:r></a:p></p:notes>',
  });
  const t = await extractFromBuffer(buf, 'deck.pptx');
  assert.ok(t.indexOf('## Slide 1') < t.indexOf('## Slide 2') && t.indexOf('## Slide 2') < t.indexOf('## Slide 10'));
  assert.match(t, /Second\n\nSpeaker notes: Say this aloud/);
  assert.doesNotMatch(t, /Speaker notes: Say this aloud\n2/);
});

test('docx: plain text out of Word', async () => {
  const buf = await zipOf({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello from Word</w:t></w:r></w:p></w:body></w:document>',
  });
  assert.match(await extractFromBuffer(buf, 'a.docx'), /Hello from Word/);
});

test('plain text, markdown and csv pass through; old Office formats say how to convert', async () => {
  assert.equal(await extractFromBuffer(Buffer.from('a,b\n1,2'), 'x.csv'), 'a,b\n1,2');
  assert.equal(await extractFromBuffer(Buffer.from('# Title'), 'x.md'), '# Title');
  await assert.rejects(extractFromBuffer(Buffer.from('x'), 'old.xls'), /save it as \.xlsx/);
  await assert.rejects(extractFromBuffer(Buffer.from('x'), 'old.doc'), /save it as \.docx/);
});
