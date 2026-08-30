import { describe, expect, it, vi } from 'vitest';
import { copyPlainText } from './copy-text';

describe('copyPlainText', () => {
  it('trims and copies a non-empty value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await expect(copyPlainText('  laoyaoke  ', { writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('laoyaoke');
  });

  it('reports unsupported and rejected clipboard writes', async () => {
    await expect(copyPlainText('laoyaoke', undefined)).resolves.toBe(false);
    await expect(
      copyPlainText('laoyaoke', {
        writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')),
      }),
    ).resolves.toBe(false);
  });

  it('does not write an empty value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await expect(copyPlainText('   ', { writeText })).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
