import { cp, mkdir, writeFile, chmod, rm, lstat } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
const root = new URL('.', import.meta.url);
await rm(new URL('dist/', root), { recursive: true, force: true });
await mkdir(new URL('dist/bin/', root), { recursive: true });
await cp(new URL('../../skills/tokems-admin/scripts/', root), new URL('dist/runtime/', root), {
  recursive: true,
  filter: async (path) => {
    const entry = await lstat(path);
    return entry.isDirectory() || (entry.isFile() && /\.(?:js|mjs|swift)$/u.test(path) && !path.endsWith('.test.mjs'));
  },
});
await cp(new URL('../../LICENSE', root), new URL('LICENSE', root));
await writeFile(
  new URL('dist/bin/tokems.js', root),
  "#!/usr/bin/env node\nvoid import('../runtime/tokems-admin.js');\n",
);
await chmod(fileURLToPath(new URL('dist/bin/tokems.js', root)), 0o755);
