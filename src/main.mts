import { InMemoryRunner } from '@google/adk';
import { createUserContent } from '@google/genai';
import { buildLeadWorkflow } from './agent_worflow.mts';
import { CompanyApiLeadSource } from './company_api_lead_source.mts';

const prompt = process.argv.slice(2).join(' ');

if (prompt?.trim().length === 0) {
  throw new Error('Your input is required!');
}
console.log(`Your prompt: ${prompt}`);

const runner = new InMemoryRunner({
  agent: buildLeadWorkflow(new CompanyApiLeadSource(process.env.COMPANY_API_KEY ?? '')),
});
const session = await runner.sessionService.createSession({
  appName: runner.appName,
  userId: 'sajan',
});

for await (const event of runner.runAsync({
  userId: session.userId,
  sessionId: session.id,
  newMessage: createUserContent(prompt),
})) {
  const text = event.content?.parts
    ?.map((p) => p.text)
    .filter(Boolean)
    .join('');
  if (!text) continue;
  if (event.author === 'reviewer') console.log(text);
  else console.log(`[${event.author}] done`);
}
