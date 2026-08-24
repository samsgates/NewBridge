import { NewBridge } from '@newbridge/sdk';
import { createMcpServer, serveMcpStdio } from '@newbridge/mcp';

const nb = new NewBridge({
  instance: process.env.SERVICENOW_INSTANCE!,
  auth: { type: 'bearer', token: process.env.SERVICENOW_TOKEN! }
});

serveMcpStdio(() => createMcpServer(nb, {
  connectionName: 'prod',
  allowWrite: false,
  maxRecords: 50,
  allowedTables: ['incident', 'problem', 'change_request', 'cmdb_ci'],
  policy: {
    default: 'deny',
    allow: [{ tables: ['incident', 'problem', 'change_request', 'cmdb_ci'], operations: ['read'] }],
    deny: [], approvals: [], redaction: { fields: ['password', 'token', 'secret'], regex: [] }
  }
}));
