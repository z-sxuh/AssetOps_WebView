import { createElement, Fragment, type ReactNode } from 'react';

function safeLink(value: string): string | undefined {
  if (!/^(https?:\/\/|mailto:)/i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return undefined;
  try { return new URL(value).href; } catch { return undefined; }
}

function inline(text: string): ReactNode[] {
  const tokens = /`([^`\n]+)`|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    const start = match.index ?? 0;
    if (start > offset) nodes.push(text.slice(offset, start).replaceAll('&nbsp;', '\u00a0'));
    if (match[1] !== undefined) nodes.push(<code key={start}>{match[1]}</code>);
    else if (match[2] !== undefined || match[3] !== undefined) nodes.push(<strong key={start}>{inline(match[2] ?? match[3])}</strong>);
    else if (match[4] !== undefined || match[5] !== undefined) nodes.push(<em key={start} style={{ fontStyle: 'normal', fontWeight: 600 }}>{inline(match[4] ?? match[5])}</em>);
    else {
      const href = safeLink(match[7]);
      nodes.push(href ? <a key={start} href={href} target="_blank" rel="noopener noreferrer">{inline(match[6])}</a> : <Fragment key={start}>{match[0]}</Fragment>);
    }
    offset = start + match[0].length;
  }
  if (offset < text.length) nodes.push(text.slice(offset).replaceAll('&nbsp;', '\u00a0'));
  return nodes;
}

const listLine = (line: string) => /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(line);
const beginsBlock = (line: string) => /^(?:#{1,6}\s|\s*```|\s*>)/.test(line) || Boolean(listLine(line));
const tableCells = (line: string) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
const beginsTable = (line: string, divider?: string) => line.includes('|') && Boolean(divider && tableCells(divider).length === tableCells(line).length && tableCells(divider).every((cell) => /^:?-{3,}:?$/.test(cell)));

function blocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const key = index;
    if (!line.trim()) { index += 1; continue; }
    if (beginsTable(line, lines[index + 1])) {
      const headers = tableCells(line); const align = tableCells(lines[index + 1]).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' as const : cell.endsWith(':') ? 'right' as const : 'left' as const);
      const rows: string[][] = []; index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) rows.push(tableCells(lines[index++]));
      nodes.push(<table key={key}><thead><tr>{headers.map((cell, column) => <th key={column} style={{ textAlign: align[column] }}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, column) => <td key={column} style={{ textAlign: align[column] }}>{inline(row[column] ?? '')}</td>)}</tr>)}</tbody></table>);
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      nodes.push(<pre key={key}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line);
    if (heading) {
      nodes.push(createElement(`h${heading[1].length}`, { key }, inline(heading[2])));
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
      nodes.push(<blockquote key={key}>{blocks(quote.join('\n'))}</blockquote>);
      continue;
    }
    const item = listLine(line);
    if (item) {
      const ordered = !item[1];
      const items: ReactNode[] = [];
      const start = ordered ? Number(/^\s*(\d+)/.exec(line)?.[1]) : undefined;
      while (index < lines.length) {
        const next = listLine(lines[index]);
        if (!next || Boolean(next[1]) === ordered) break;
        items.push(<li key={index}>{inline(next[2])}</li>);
        index += 1;
      }
      nodes.push(ordered ? <ol key={key} start={start}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    const paragraph: ReactNode[] = [];
    do {
      if (paragraph.length) paragraph.push(<br key={`br-${index}`} />);
      paragraph.push(<Fragment key={index}>{inline(lines[index++])}</Fragment>);
    } while (index < lines.length && lines[index].trim() && !beginsBlock(lines[index]) && !beginsTable(lines[index], lines[index + 1]));
    nodes.push(<p key={key}>{paragraph}</p>);
  }
  return nodes;
}

export default function BasicMarkdown({ text }: { text: string }) {
  return <div className="basic-markdown">{blocks(text)}</div>;
}
