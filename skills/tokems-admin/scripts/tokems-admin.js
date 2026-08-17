#!/usr/bin/env node

void import('./tokems-admin.mjs').catch(() => {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code: 'CONNECTOR_LOAD_FAILED',
      message: 'TokEMS Admin connector could not be loaded',
    })}\n`,
  );
  process.exitCode = 1;
});
