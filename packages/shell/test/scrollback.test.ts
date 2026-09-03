import { beforeEach, describe, expect, it } from 'vitest';
import { dropScrollback, readScrollback, recordScrollback } from '../src/scrollback.js';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const S = 'session-under-test';

describe('scrollback', () => {
  beforeEach(() => dropScrollback(S));

  it('keeps plain output', () => {
    recordScrollback(S, 'hello\r\nworld\r\n');
    expect(readScrollback(S, 10)).toBe('hello\nworld');
  });

  it('strips colour without eating the text', () => {
    recordScrollback(S, `${ESC}[38;5;68mgreen${ESC}[0m text\r\n`);
    expect(readScrollback(S, 10)).toBe('green text');
  });

  it('strips a complete OSC sequence', () => {
    recordScrollback(S, `${ESC}]0;a window title${BEL}after\r\n`);
    expect(readScrollback(S, 10)).toBe('after');
  });

  /**
   * The regression that made this file exist: a pty splits on buffer
   * boundaries, not sequence boundaries, so Helm's own OSC 7376 arrived in
   * pieces and its base64 payload was quoted back to the model as if the
   * terminal had printed it.
   */
  it('holds an escape sequence split across chunks', () => {
    recordScrollback(S, `before\r\n${ESC}]7376;X19hcmd1bWVudHMg`);
    expect(readScrollback(S, 10)).toBe('before');
    recordScrollback(S, `X19udm1fYWxpYXM=${BEL}after\r\n`);
    expect(readScrollback(S, 10)).toBe('before\nafter');
  });

  it('holds a CSI split mid-sequence', () => {
    recordScrollback(S, `x${ESC}[38;5`);
    recordScrollback(S, `;68my\r\n`);
    expect(readScrollback(S, 10)).toBe('xy');
  });

  it('shows the line being typed before its newline arrives', () => {
    recordScrollback(S, 'prompt % git st');
    expect(readScrollback(S, 10)).toBe('prompt % git st');
  });

  it('caps history so a runaway command cannot grow it without bound', () => {
    for (let i = 0; i < 500; i++) recordScrollback(S, `line ${i}\r\n`);
    const lines = readScrollback(S, 300).split('\n');
    expect(lines).toHaveLength(300);
    expect(lines[lines.length - 1]).toBe('line 499');
  });

  it('returns nothing for a session it has never seen', () => {
    expect(readScrollback('no-such-session', 10)).toBe('');
    expect(readScrollback(null, 10)).toBe('');
  });
});
