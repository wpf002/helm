import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateScope, isWithinRoots, resolveAffectedPaths } from '../src/scope.js';

/**
 * The containment tests. Every case here is a way a scope guard gets walked
 * out of, so a regression means the permission layer is lying about reach.
 */
describe('scope containment', () => {
  let base: string;
  let home: string;
  let outside: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'helm-scope-'));
    home = join(base, 'home');
    outside = join(base, 'outside');
    await mkdir(join(home, 'sub'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await writeFile(join(home, 'plain.txt'), 'inside');
    // A symlink living inside the root but pointing out of it.
    await symlink(outside, join(home, 'escape'));
    await symlink(join(outside, 'secret.txt'), join(home, 'link.txt'));
    // A sibling sharing the root's prefix: /…/home-evil must not count as
    // inside /…/home.
    await mkdir(join(base, 'home-evil'), { recursive: true });
    await writeFile(join(base, 'home-evil', 'x.txt'), 'evil');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const verdict = (tool: string, input: unknown) => evaluateScope(tool, input, home, [home]);

  it('accepts a plain file inside the root', async () => {
    expect((await verdict('Read', { file_path: join(home, 'plain.txt') })).outOfScope).toBe(false);
  });

  it('rejects a file outside the root', async () => {
    expect((await verdict('Read', { file_path: join(outside, 'secret.txt') })).outOfScope).toBe(true);
  });

  it('rejects a symlink that points outside the root', async () => {
    const result = await verdict('Read', { file_path: join(home, 'link.txt') });
    expect(result.outOfScope).toBe(true);
    expect(result.factors.map((f) => f.rule)).toContain('symlink-resolved');
  });

  it('rejects a write through a symlinked directory', async () => {
    // The file does not exist yet, so there is no realpath for it — the guard
    // has to resolve the nearest existing ancestor instead.
    expect((await verdict('Write', { file_path: join(home, 'escape', 'new.txt') })).outOfScope).toBe(true);
  });

  it('rejects a sibling directory sharing the root prefix', async () => {
    expect((await verdict('Read', { file_path: join(base, 'home-evil', 'x.txt') })).outOfScope).toBe(true);
  });

  it('accepts a file that does not exist yet inside the root', async () => {
    expect((await verdict('Write', { file_path: join(home, 'sub', 'brand-new.txt') })).outOfScope).toBe(false);
  });

  it('treats a command with no parsable paths as unresolved, not safe', async () => {
    const result = await verdict('Bash', { command: 'env | sort' });
    expect(result.outOfScope).toBe(true);
    expect(result.factors.map((f) => f.rule)).toContain('unresolved-command');
  });

  it('pulls paths out of a shell command', async () => {
    expect((await verdict('Bash', { command: `cat ${outside}/secret.txt` })).outOfScope).toBe(true);
    expect((await verdict('Bash', { command: `cat ${home}/plain.txt` })).outOfScope).toBe(false);
  });

  it('denies everything when no roots are configured', async () => {
    expect(await isWithinRoots(join(home, 'plain.txt'), [])).toBe(false);
  });

  it('follows symlinks in isWithinRoots', async () => {
    expect(await isWithinRoots(join(home, 'link.txt'), [home])).toBe(false);
    expect(await isWithinRoots(join(home, 'plain.txt'), [home])).toBe(true);
  });

  it('resolves paths to absolute, deduplicated form', async () => {
    const paths = await resolveAffectedPaths('Read', { file_path: 'plain.txt' }, home);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('plain.txt');
    expect(paths[0]?.startsWith('/')).toBe(true);
  });

  it('attaches a Factor to every verdict', async () => {
    const result = await verdict('Read', { file_path: join(home, 'link.txt') });
    expect(result.factors.length).toBeGreaterThan(0);
    expect(result.factors.map((f) => f.rule)).toContain('outside-roots');
  });
});
