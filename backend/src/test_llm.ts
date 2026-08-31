import dotenv from 'dotenv';
dotenv.config();
import { GeminiLLMClient, GroqLLMClient } from './llm/llm_client';

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

  console.log('\nTesting GroqLLMClient...');
  const groq = new GroqLLMClient();
  try {
    const res = await groq.generateStructuredOutput<{ rating: string }>(
      'Pick a rating from: High, Medium, Low for financial risk with $10M loss',
      'You are a risk rater',
      { type: 'OBJECT', properties: { rating: { type: 'STRING' } }, required: ['rating'] }
    );
    console.log('Groq response:', res);
  } catch (e: any) {
    console.error('Groq error:', e.message);
  }
}

main().catch(console.error);
