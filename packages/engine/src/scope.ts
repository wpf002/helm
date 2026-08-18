/**
 * Resolves the absolute paths a tool call would touch and flags anything
 * outside the configured roots. Runs before the permission prompt renders so
 * the approval UI can show scope violations rather than a raw JSON blob.
 *
 * Symlinks are resolved before the containment check. Skipping that is how
 * scope guards get walked out of.
 */
export declare function resolveAffectedPaths(
  toolName: string,
  input: unknown,
  cwd: string,
): Promise<string[]>;

export declare function isWithinRoots(path: string, roots: readonly string[]): Promise<boolean>;
