import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { partnerPosterArchive } from './partner-poster-download';

describe('partner poster ZIP files', () => {
  it('preserves same-name posters with filesystem-safe Unicode filenames', async () => {
    const filename = `${'林'.repeat(80)}-${'🌍'.repeat(90)}-推广海报.png`;
    const archive = await partnerPosterArchive([
      { filename, blob: new Blob(['first PNG']) },
      { filename, blob: new Blob(['second PNG']) },
      { filename: '../folder/\u0000poster.png', blob: new Blob(['third PNG']) },
    ]);
    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(files)).toHaveLength(3);
    for (const name of Object.keys(files)) {
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
      expect(name).toMatch(/^\d+-.*\.png$/u);
      expect(name).not.toMatch(/[\\/\p{Cc}\ufffd]/u);
    }
    expect(Object.values(files).map(bytes => new TextDecoder().decode(bytes))).toEqual(['first PNG', 'second PNG', 'third PNG']);
  });

  it('rejects an empty archive', async () => {
    await expect(partnerPosterArchive([])).rejects.toThrow('没有可下载的海报');
  });
});
