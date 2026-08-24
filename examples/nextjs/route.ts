// Place this in app/api/incidents/route.ts in a Next.js server application.
import { NextResponse } from 'next/server';
import { NewBridge } from '@newbridge/sdk';

const sn = new NewBridge({
  instance: process.env.SERVICENOW_INSTANCE!,
  auth: { type: 'bearer', token: process.env.SERVICENOW_TOKEN! }
});

export async function GET() {
  const incidents = await sn.table('incident')
    .where('active', true)
    .select(['sys_id', 'number', 'short_description', 'priority'])
    .limit(50)
    .find();
  return NextResponse.json({ incidents });
}
