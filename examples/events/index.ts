import { NewBridge } from '@newbridge/sdk';
import { EventClient } from '@newbridge/events';

const sn = new NewBridge({
  instance: process.env.SERVICENOW_INSTANCE!,
  auth: { type: 'bearer', token: process.env.SERVICENOW_TOKEN! }
});

const watcher = new EventClient(sn).watch({ connection: 'dev', table: 'incident', intervalMs: 10_000 });
watcher.on('event', event => console.log(JSON.stringify(event, null, 2)));
watcher.on('error', error => console.error(error));
await watcher.start();
