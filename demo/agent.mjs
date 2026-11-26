// Synthetic fixture. Orbu analyses this file but never executes it.
import OpenAI from 'openai';
export async function POST() {
  return new OpenAI().responses.create({ model: 'demo-model', input: 'Synthetic support request' });
}
