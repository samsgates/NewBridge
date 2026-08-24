#!/usr/bin/env node
import { Command } from 'commander';
import YAML from 'yaml';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { NewBridge, type NewBridgeConfig } from '@newbridge/sdk';
import { diffSchemas, generateTypeScript, type SchemaBundle } from '@newbridge/schema';
import { startEmulator, seedFromFile } from '@newbridge/emulator';
import { createGateway, type GatewayConnection } from '@newbridge/gateway';
import { EventClient } from '@newbridge/events';

interface ConfigFile {
  version: 1;
  defaultConnection?: string;
  connections: Record<string, NewBridgeConfig>;
  gateway?: { databaseUrl?: string; redisUrl?: string; apiKeys?: string[]; policy?: unknown; host?: string; port?: number; allowRawQuery?: boolean };
}

function interpolate(input: string): string {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g, (_m, name, fallback) => {
    const value = process.env[name] ?? fallback;
    if (value === undefined) throw new Error(`Environment variable ${name} is required`);
    return value;
  });
}

async function loadConfig(file = 'newbridge.config.yaml'): Promise<ConfigFile> {
  const text = interpolate(await readFile(resolve(file), 'utf8'));
  const config = YAML.parse(text) as ConfigFile;
  if (config.version !== 1 || !config.connections || !Object.keys(config.connections).length) throw new Error('Invalid NewBridge config. version: 1 and at least one connection are required.');
  return config;
}

async function getClient(connectionName?: string, configFile?: string): Promise<{ nb: NewBridge; name: string; config: ConfigFile }> {
  const config = await loadConfig(configFile);
  const name = connectionName ?? config.defaultConnection ?? Object.keys(config.connections)[0]!;
  const connection = config.connections[name];
  if (!connection) throw new Error(`Connection ${name} does not exist`);
  return { nb: new NewBridge(connection), name, config };
}

function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

const program = new Command();
program.name('newbridge').description('NewBridge ServiceNow integration runtime CLI').version('0.1.0');
program.option('-c, --config <file>', 'config file', 'newbridge.config.yaml');

program.command('init').description('create a starter NewBridge configuration').option('-f, --force').action(async opts => {
  const file = resolve(program.opts().config);
  try { if (!opts.force) { await readFile(file); throw new Error(`${file} already exists. Use --force to overwrite.`); } } catch (error: any) { if (error.code !== 'ENOENT' && !String(error.message).includes('already exists')) throw error; if (String(error.message).includes('already exists')) throw error; }
  const starter = `version: 1\ndefaultConnection: dev\n\nconnections:\n  dev:\n    instance: \${SERVICENOW_INSTANCE}\n    auth:\n      type: bearer\n      token: \${SERVICENOW_TOKEN}\n    resilience:\n      retries: 3\n      concurrency: 10\n\ngateway:\n  databaseUrl: \${DATABASE_URL:-postgres://newbridge:newbridge@localhost:5432/newbridge}\n  redisUrl: \${REDIS_URL:-redis://localhost:6379}\n`;
  await writeFile(file, starter); console.log(`Created ${file}`);
});

program.command('doctor').description('check connectivity and common integration requirements').option('--connection <name>').action(async opts => {
  const { nb, name } = await getClient(opts.connection, program.opts().config);
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const health = await nb.health(); checks.push({ name: 'ServiceNow connectivity', ok: health.ok, detail: health.error });
  if (health.ok) {
    try { await nb.table('incident').select(['sys_id']).limit(1).find(); checks.push({ name: 'Table API', ok: true }); } catch (e) { checks.push({ name: 'Table API', ok: false, detail: e instanceof Error ? e.message : String(e) }); }
    try { await nb.table('sys_dictionary').select(['sys_id']).limit(1).find(); checks.push({ name: 'Schema metadata access', ok: true }); } catch (e) { checks.push({ name: 'Schema metadata access', ok: false, detail: e instanceof Error ? e.message : String(e) }); }
  }
  console.log(`NewBridge doctor: ${name}`); for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  if (checks.some(c => !c.ok)) process.exitCode = 1;
});

const connection = program.command('connection').description('manage configured connections');
connection.command('list').action(async () => { const config = await loadConfig(program.opts().config); Object.keys(config.connections).forEach(name => console.log(`${name}${name === config.defaultConnection ? ' *' : ''}`)); });
connection.command('test').argument('[name]').action(async name => { const { nb } = await getClient(name, program.opts().config); print(await nb.health()); });

const schema = program.command('schema').description('schema discovery and diff');
schema.command('pull').option('--connection <name>').option('-o, --output <file>', 'output JSON', '.newbridge/schema.json').option('--table <table...>').action(async opts => {
  const { nb } = await getClient(opts.connection, program.opts().config); const bundle = await nb.schemaDiscovery({ includeTables: opts.table }).pull();
  await mkdir(dirname(resolve(opts.output)), { recursive: true }); await writeFile(resolve(opts.output), JSON.stringify(bundle, null, 2)); console.log(`Wrote ${bundle.tables.length} tables to ${opts.output}`);
});
schema.command('diff').argument('<from>').argument('<to>').action(async (fromFile, toFile) => {
  const [a,b] = await Promise.all([readFile(resolve(fromFile),'utf8'), readFile(resolve(toFile),'utf8')]); const diffs = diffSchemas(JSON.parse(a), JSON.parse(b)); print({ differences: diffs, breaking: diffs.filter(d => d.severity === 'breaking').length });
  if (diffs.some(d => d.severity === 'breaking')) process.exitCode = 2;
});

program.command('generate').description('generate TypeScript models from a schema bundle').option('-i, --input <file>', 'schema bundle', '.newbridge/schema.json').option('-o, --output <dir>', 'generated source directory', 'src/newbridge/generated').action(async opts => {
  const bundle = JSON.parse(await readFile(resolve(opts.input),'utf8')) as SchemaBundle; const files = generateTypeScript(bundle); await mkdir(resolve(opts.output), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(resolve(opts.output, name), content); console.log(`Generated ${Object.keys(files).length} files in ${opts.output}`);
});

program.command('query').argument('<table>').option('--connection <name>').option('--where <encodedQuery>').option('--limit <number>', 'row limit', '20').action(async (table, opts) => {
  const { nb } = await getClient(opts.connection, program.opts().config);
  if (opts.where) { if (String(opts.where).includes('javascript:')) throw new Error('javascript: queries are disabled by CLI'); const result = await nb.rest.call({ method:'GET', path:`/api/now/table/${encodeURIComponent(table)}`, query:{sysparm_query:opts.where,sysparm_limit:Number(opts.limit)} }); print(result); }
  else print(await nb.table(table).limit(Number(opts.limit)).find());
});

const record = program.command('record').description('record CRUD');
record.command('get').argument('<table>').argument('<sysId>').option('--connection <name>').action(async (table,sysId,opts)=>{ const {nb}=await getClient(opts.connection,program.opts().config); print(await nb.table(table).get(sysId)); });
record.command('create').argument('<table>').requiredOption('--json <json>').option('--connection <name>').action(async (table,opts)=>{ const {nb}=await getClient(opts.connection,program.opts().config); print(await nb.table(table).create(JSON.parse(opts.json))); });
record.command('update').argument('<table>').argument('<sysId>').requiredOption('--json <json>').option('--connection <name>').action(async (table,sysId,opts)=>{ const {nb}=await getClient(opts.connection,program.opts().config); print(await nb.table(table).update(sysId,JSON.parse(opts.json))); });
record.command('delete').argument('<table>').argument('<sysId>').option('--connection <name>').option('--yes', 'confirm deletion').action(async (table,sysId,opts)=>{ if(!opts.yes) throw new Error('Deletion requires --yes'); const {nb,name}=await getClient(opts.connection,program.opts().config); console.error(`Deleting ${table}/${sysId} from ${name}`); await nb.table(table).delete(sysId); console.log('Deleted'); });

const emulator = program.command('emulator').description('local ServiceNow-compatible development emulator');
emulator.command('start').option('--host <host>','host','127.0.0.1').option('--port <port>','port','8181').option('--seed <file>').action(async opts => { const started = await startEmulator({host:opts.host,port:Number(opts.port)}); if(opts.seed) await seedFromFile(started.store,resolve(opts.seed)); console.log(`NewBridge emulator listening on ${started.url}`); });

const events = program.command('events').description('event polling');
events.command('listen').argument('<table>').option('--connection <name>').option('--interval <ms>','poll interval','10000').action(async (table,opts)=>{ const {nb,name}=await getClient(opts.connection,program.opts().config); const watcher=new EventClient(nb).watch({table,connection:name,intervalMs:Number(opts.interval)}); watcher.on('event', e=>print(e)); watcher.on('error',e=>console.error(e)); await watcher.start(); });

const gateway = program.command('gateway').description('enterprise NewBridge gateway');
gateway.command('start').action(async ()=>{ const config=await loadConfig(program.opts().config); const connections=Object.entries(config.connections).map(([name,c])=>({name,...c})) as GatewayConnection[]; const g=await createGateway({connections,databaseUrl:config.gateway?.databaseUrl,redisUrl:config.gateway?.redisUrl,apiKeys:config.gateway?.apiKeys,policy:config.gateway?.policy,allowRawQuery:config.gateway?.allowRawQuery,host:config.gateway?.host,port:config.gateway?.port}); const host=config.gateway?.host??'0.0.0.0',port=config.gateway?.port??8080; await g.app.listen({host,port}); console.log(`NewBridge Gateway listening on http://${host}:${port}`); });

program.command('config').description('configuration utilities').command('validate').action(async()=>{ const config=await loadConfig(program.opts().config); console.log(`Valid configuration with ${Object.keys(config.connections).length} connection(s).`); });

program.parseAsync().catch(error => { console.error(`NewBridge: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
