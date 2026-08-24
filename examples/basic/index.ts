import { NewBridge } from '@newbridge/sdk';

const sn = new NewBridge({
  instance: process.env.SERVICENOW_INSTANCE!,
  auth: { type: 'bearer', token: process.env.SERVICENOW_TOKEN! },
  resilience: { retries: 3, concurrency: 10, circuitBreaker: true }
});

const incidents = await sn.table('incident')
  .where('active', true)
  .whereIn('priority', ['1', '2'])
  .select(['sys_id', 'number', 'short_description', 'priority'])
  .limit(20)
  .find();

console.log(incidents);
