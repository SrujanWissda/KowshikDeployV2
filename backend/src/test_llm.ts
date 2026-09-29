import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { GeminiLLMClient, GroqLLMClient, DeepInfraLLMClient } from './llm/llm_client';

async function main() {
  console.log('Testing GeminiLLMClient...');
  const gemini = new GeminiLLMClient();
  try {
    const res = await gemini.generateStructuredOutput<{ rating: string }>(
      'Pick a rating from: High, Medium, Low for financial risk with $10M loss',
      'You are a risk rater',
      { type: 'OBJECT', properties: { rating: { type: 'STRING' } }, required: ['rating'] }
    );
    console.log('Gemini response:', res);
  } catch (e: any) {
    console.error('Gemini error:', e.message);
  }

  console.log('\nTesting DeepInfraLLMClient (GLM-4.7)...');
  const deepInfra = new DeepInfraLLMClient();
  try {
    const res = await deepInfra.generateStructuredOutput<{ rating: string }>(
      'Pick a rating from: High, Medium, Low for financial risk with $10M loss',
      'You are a risk rater',
      { type: 'object', properties: { rating: { type: 'string' } }, required: ['rating'] }
    );
    console.log('DeepInfra GLM-4.7 response:', res);
  } catch (e: any) {
    console.error('DeepInfra error:', e.message);
  }
}

main().catch(console.error);
