// Pipe a sanitized research JSON object on stdin. Credentials come only from environment.
// node scripts/publish-scout.mjs --publish < research.json
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString('utf8');
if (Buffer.byteLength(text) > 8192) throw Error('Research request exceeds 8 KiB.');
const data = JSON.parse(text);
if (!Array.isArray(data.markets) || data.markets.length > 10) throw Error('markets must contain zero to ten entries.');
if (!process.argv.includes('--publish')) {
  console.log(`Dry run: ${data.markets.length} researched markets; no request sent. Use --publish to submit for server validation.`);
} else {
  const endpoint = new URL(process.env.SCOUT_SERVER_URL || '');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw Error('SCOUT_SERVER_URL must be an HTTPS server origin.');
  if (!process.env.SCOUT_PUBLISH_KEY) throw Error('SCOUT_PUBLISH_KEY is missing.');
  const response = await fetch(new URL('/api/scout/research', endpoint), {
    method:'POST', redirect:'error', headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.SCOUT_PUBLISH_KEY}`},
    body:JSON.stringify({markets:data.markets})
  });
  if (!response.ok) throw Error(`Scout publisher returned HTTP ${response.status}.`);
  const result = await response.json();
  console.log(JSON.stringify({published:result.published,reportId:result.report?.id,status:result.report?.status,candidates:result.report?.candidates?.length}));
}
