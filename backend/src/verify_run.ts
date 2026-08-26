import dotenv from 'dotenv';
dotenv.config();

import { ServiceNowAdapter } from './adapters/servicenow';
import { GeminiLLMClient } from './llm/llm_client';
import { ControlEffectivenessAgent } from './core/agents';
import { withTrace } from './core/observability';

async function main() {
  const instanceId = '01b116b883ae0790fba8c4e0deaad3d7';
  console.log(`Starting optimized execution verification against ServiceNow Instance: ${instanceId}`);
  
  const adapter = new ServiceNowAdapter();
  const llm = new GeminiLLMClient();
  const agent = new ControlEffectivenessAgent(adapter, llm);
  
  const t0 = Date.now();
  try {
    const result = await withTrace('run-agent', { platform: 'servicenow', agent: 'control-effectiveness', targetId: instanceId }, async () => {
      return await agent.execute(instanceId);
    });
    const duration = (Date.now() - t0) / 1000;
    console.log('Execution finished successfully!');
    console.log('Duration:', duration.toFixed(2), 'seconds');
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (error: any) {
    console.error('Execution failed:', error.message);
  }
}

main();
