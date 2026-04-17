/**
 * Unit tests for markdown-utils.ts.
 * Run: npx tsx test/markdown-utils.test.ts
 */

import assert from 'node:assert/strict';
import { parseRow, parseMarkdownSegments, hasMarkdownTable, buildCardJson, normalizeTaskList } from '../markdown-utils.js';

// ─── parseRow ────────────────────────────────────────────────────────────────

function testParseRow() {
  assert.deepEqual(parseRow('| a | b | c |'), ['a', 'b', 'c']);
  assert.deepEqual(parseRow('a | b | c'), ['a', 'b', 'c']);
  assert.deepEqual(parseRow('|single|'), ['single']);
  assert.deepEqual(parseRow('|  trimmed  |'), ['trimmed']);
  assert.deepEqual(parseRow('no pipes just text'), ['no pipes just text']);
  console.log('  ✓ parseRow');
}

// ─── hasMarkdownTable ────────────────────────────────────────────────────────

function testHasMarkdownTable() {
  // Basic table
  assert.equal(hasMarkdownTable('| a | b |\n|---|---|\n| 1 | 2 |'), true);

  // No table
  assert.equal(hasMarkdownTable('just plain text'), false);

  // Separator-like but no second line with pipes
  assert.equal(hasMarkdownTable('some text | here'), false);

  // Empty string
  assert.equal(hasMarkdownTable(''), false);

  // Table at end of text
  assert.equal(hasMarkdownTable('intro\n\n| H1 | H2 |\n|----|----|\n| v1 | v2 |'), true);

  // Pipe in text but no separator line
  assert.equal(hasMarkdownTable('a | b without separator'), false);

  // Whitespace in separator
  assert.equal(hasMarkdownTable('| a | b |\n| --- | --- |\n| 1 | 2 |'), true);

  // Mixed alignment separators
  assert.equal(hasMarkdownTable('| a | b |\n|:---|---:|\n| 1 | 2 |'), true);

  console.log('  ✓ hasMarkdownTable');
}

// ─── parseMarkdownSegments ───────────────────────────────────────────────────

function testParseMarkdownSegments() {
  // Pure text
  const textOnly = parseMarkdownSegments('hello\nworld');
  assert.equal(textOnly.length, 1);
  assert.equal(textOnly[0].type, 'text');
  assert.equal(textOnly[0].content, 'hello\nworld');

  // Pure table
  const tableOnly = parseMarkdownSegments('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(tableOnly.length, 1);
  assert.equal(tableOnly[0].type, 'table');
  assert.deepEqual(tableOnly[0].headers, ['a', 'b']);
  assert.deepEqual(tableOnly[0].rows, [['1', '2']]);

  // Mixed text + table + text
  const mixed = parseMarkdownSegments('intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\noutro');
  assert.equal(mixed.length, 3);
  assert.equal(mixed[0].type, 'text');
  assert.equal(mixed[0].content, 'intro\n');
  assert.equal(mixed[1].type, 'table');
  assert.equal(mixed[2].type, 'text');
  assert.equal(mixed[2].content, '\noutro');

  // Chinese content in table
  const chinese = parseMarkdownSegments('| 股票 | 价格 |\n|------|------|\n| 茅台 | 1800 |');
  assert.equal(chinese.length, 1);
  assert.equal(chinese[0].type, 'table');
  assert.deepEqual(chinese[0].headers, ['股票', '价格']);
  assert.deepEqual(chinese[0].rows, [['茅台', '1800']]);

  console.log('  ✓ parseMarkdownSegments');
}

// ─── buildCardJson ───────────────────────────────────────────────────────────

function testBuildCardJson() {
  // Text only
  const textCard = JSON.parse(buildCardJson([
    { type: 'text', content: 'hello world' },
  ]));
  assert.deepEqual(textCard.elements, [{ tag: 'markdown', content: 'hello world' }]);
  assert.deepEqual(textCard.config, { wide_screen_mode: true });

  // Table only
  const tableCard = JSON.parse(buildCardJson([
    { type: 'table', headers: ['Name', 'Age'], rows: [['Alice', '30']] },
  ]));
  assert.equal(tableCard.elements[0].tag, 'table');
  assert.equal(tableCard.elements[0].columns.length, 2);
  assert.equal(tableCard.elements[0].columns[0].display_name, 'Name');
  assert.equal(tableCard.elements[0].columns[1].display_name, 'Age');
  assert.deepEqual(tableCard.elements[0].rows[0], { c0: 'Alice', c1: '30' });

  // Mixed
  const mixedCard = JSON.parse(buildCardJson([
    { type: 'text', content: 'report:' },
    { type: 'table', headers: ['A', 'B'], rows: [['1', '2']] },
    { type: 'text', content: 'done' },
  ]));
  assert.equal(mixedCard.elements.length, 3);
  assert.equal(mixedCard.elements[0].tag, 'markdown');
  assert.equal(mixedCard.elements[1].tag, 'table');
  assert.equal(mixedCard.elements[2].tag, 'markdown');

  // Empty text segments are skipped
  const emptyText = JSON.parse(buildCardJson([
    { type: 'text', content: '   ' },
    { type: 'text', content: 'real' },
  ]));
  assert.equal(emptyText.elements.length, 1);

  console.log('  ✓ buildCardJson');
}

// ─── Regression: the bug that started this ──────────────────────────────────
// Ensures markdown table detection works on content that looks like it might
// have false-positive pipe characters (e.g. code, links, paths)

function testNoFalsePositives() {
  // URL with pipes is not a table
  assert.equal(hasMarkdownTable('see http://example.com/a|b|c'), false);

  // Bash pipe in code block line
  assert.equal(hasMarkdownTable('cat file | grep foo'), false);

  // Just a separator line without header above
  assert.equal(hasMarkdownTable('---\nsome text'), false);

  console.log('  ✓ no false positives');
}

// ─── normalizeTaskList ───────────────────────────────────────────────────────

function testNormalizeTaskList() {
  // Unchecked → ☐
  assert.equal(normalizeTaskList('- [ ] todo'), '☐ todo');
  // Checked → ✅ (both lowercase and uppercase x)
  assert.equal(normalizeTaskList('- [x] done'), '✅ done');
  assert.equal(normalizeTaskList('- [X] DONE'), '✅ DONE');

  // Different list markers
  assert.equal(normalizeTaskList('* [ ] a'), '☐ a');
  assert.equal(normalizeTaskList('+ [x] b'), '✅ b');

  // Indentation is preserved
  assert.equal(normalizeTaskList('  - [ ] nested'), '  ☐ nested');
  assert.equal(normalizeTaskList('    - [x] deep'), '    ✅ deep');

  // Multiline
  const multi = normalizeTaskList('- [x] a\n- [ ] b\n- [x] c');
  assert.equal(multi, '✅ a\n☐ b\n✅ c');

  // Non-task bullets untouched
  assert.equal(normalizeTaskList('- plain item\n- [ ] task'), '- plain item\n☐ task');

  // Inline `[ ]` (not at start of list item) untouched
  assert.equal(normalizeTaskList('text [ ] not a task'), 'text [ ] not a task');

  // Empty / no matches
  assert.equal(normalizeTaskList(''), '');
  assert.equal(normalizeTaskList('plain text'), 'plain text');

  console.log('  ✓ normalizeTaskList');
}

// Card markdown segments should also be normalized
function testBuildCardJsonNormalizesTaskList() {
  const card = JSON.parse(buildCardJson([
    { type: 'text', content: '## 待办\n- [x] 已完成\n- [ ] 未完成' },
  ]));
  assert.equal(card.elements[0].tag, 'markdown');
  assert.ok(card.elements[0].content.includes('✅ 已完成'));
  assert.ok(card.elements[0].content.includes('☐ 未完成'));
  assert.ok(!card.elements[0].content.includes('- [x]'));
  assert.ok(!card.elements[0].content.includes('- [ ]'));
  console.log('  ✓ buildCardJson normalizes task lists');
}

// ─── Run all ─────────────────────────────────────────────────────────────────

console.log('\nmarkdown-utils:');
testParseRow();
testHasMarkdownTable();
testParseMarkdownSegments();
testBuildCardJson();
testNoFalsePositives();
testNormalizeTaskList();
testBuildCardJsonNormalizesTaskList();
console.log('All tests passed.\n');
