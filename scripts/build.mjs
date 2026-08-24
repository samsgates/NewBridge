import { spawnSync } from 'node:child_process';

const order = [
  '@newbridge/query',
  '@newbridge/core',
  '@newbridge/resilience',
  '@newbridge/schema',
  '@newbridge/policy',
  '@newbridge/telemetry',
  '@newbridge/sdk',
  '@newbridge/events',
  '@newbridge/gateway',
  '@newbridge/emulator',
  '@newbridge/mcp',
  '@newbridge/cli'
];

for (const workspace of order) {
  const result = spawnSync('npm', ['run', 'build', '-w', workspace], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
