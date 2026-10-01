process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const Fastify = (await import('fastify')).default;
const { automation } = await import('../src/routes/automation.js');
const { automationRepo } = await import('../src/db/repos.js');

const app = Fastify({ logger: false });
app.setErrorHandler((error, _req, reply) => {
  if (error.statusCode && error.statusCode !== 500) return reply.code(error.statusCode).send({ error: error.message });
  console.log('HANDLER ERROR:', error.message);
  return reply.code(500).send({ error: 'internal_error' });
});
await app.register(automation);

const storeId = '89e11c91-de89-4bc8-9fd4-1de36fb75459';
const payload = {
  storeId,
  triggerType: 'clicked_no_conversion',
  triggerConfig: {},
  action: { type: 'whatsapp_text', text: 'probe rule' },
  cooldownMinutes: 1440,
  lookbackHours: 72,
};
const res = await app.inject({ method: 'POST', url: '/api/automation/rules', headers: { 'x-api-key': process.env.ADMIN_API_KEY, 'content-type': 'application/json' }, payload });
console.log('POST /api/automation/rules ->', res.statusCode, res.body);

if (res.statusCode === 200) {
  const id = res.json().id;
  const listed = await automationRepo.list(storeId);
  console.log('listed rules:', listed.length, 'probe present:', listed.some(r => r.id === id));
  await automationRepo.remove(storeId, id);
  console.log('probe rule deleted');
}
await app.close();
process.exit(0);
