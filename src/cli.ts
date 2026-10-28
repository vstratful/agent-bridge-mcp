#!/usr/bin/env node
// Keep this bootstrap free of static imports: older Node versions cannot load node:sqlite.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`agent-bridge-mcp requires Node.js 24 or newer (running ${process.versions.node} at ${process.execPath})`);
  process.exit(1);
}

import('./cli-main.js').then(({ main }) => main()).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
