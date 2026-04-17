/**
 * Pure utility functions extracted from bridge.ts for testability.
 * Markdown table detection and Feishu card JSON building.
 */

export type Segment =
  | { type: 'text'; content: string }
  | { type: 'table'; headers: string[]; rows: string[][] };

export interface Button {
  label: string;
  value: string;
  style?: 'primary' | 'default' | 'danger';
}

export function parseRow(line: string): string[] {
  // Split and trim, then strip AT MOST ONE empty cell at each end (the common
  // "| a | b | c |" wrapping). Internal empty cells are preserved so that a
  // row's column count stays aligned with its header — dropping them would
  // silently shift all subsequent cells left.
  const cells = line.split('|').map(c => c.trim());
  const start = cells.length > 0 && cells[0] === '' ? 1 : 0;
  const end = cells.length > 0 && cells[cells.length - 1] === '' ? cells.length - 1 : cells.length;
  return cells.slice(start, end);
}

// Feishu markdown (both post `tag:md` and card `tag:markdown`) does not render
// GFM task list syntax. Rewrite to unicode symbols so users see checkboxes.
export function normalizeTaskList(text: string): string {
  return text.replace(/^(\s*)[-*+]\s+\[([ xX])\]\s+/gm,
    (_m, indent: string, mark: string) => `${indent}${mark === ' ' ? '☐' : '✅'} `);
}

export function parseMarkdownSegments(text: string): Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let textBuf: string[] = [];
  let i = 0;

  const flushText = () => {
    if (textBuf.length > 0) {
      segments.push({ type: 'text', content: textBuf.join('\n') });
      textBuf = [];
    }
  };

  while (i < lines.length) {
    if (lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+[-|:\s]+$/.test(lines[i + 1])) {
      flushText();
      const headers = parseRow(lines[i]);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      segments.push({ type: 'table', headers, rows });
    } else {
      textBuf.push(lines[i]);
      i++;
    }
  }
  flushText();
  return segments;
}

export function hasMarkdownTable(text: string): boolean {
  return parseMarkdownSegments(text).some(s => s.type === 'table');
}

export function buildCardJson(segments: Segment[], buttons?: Button[]): string {
  const elements: Record<string, unknown>[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      const trimmed = normalizeTaskList(seg.content).trim();
      if (trimmed) {
        elements.push({ tag: 'markdown', content: trimmed });
      }
    } else {
      const colNames = seg.headers.map((_, idx) => `c${idx}`);
      elements.push({
        tag: 'table',
        page_size: Math.max(seg.rows.length, 1),
        row_height: 'low',
        header_style: { text_align: 'left', text_size: 'normal', background_style: 'grey' },
        columns: seg.headers.map((h, idx) => ({
          name: colNames[idx],
          display_name: h,
          data_type: 'text',
          width: 'auto',
        })),
        rows: seg.rows.map(row => {
          const obj: Record<string, string> = {};
          row.forEach((val, idx) => { obj[colNames[idx]] = val; });
          return obj;
        }),
      });
    }
  }
  if (buttons && buttons.length > 0) {
    elements.push({
      tag: 'action',
      actions: buttons.map(b => ({
        tag: 'button',
        text: { tag: 'plain_text', content: b.label },
        type: b.style ?? 'primary',
        // Label is stuffed into value so the card.action.trigger handler can
        // recover both the user-facing label and Claude's payload string.
        value: { label: b.label, value: b.value },
      })),
    });
  }
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    elements,
  });
}
