import dotenv from 'dotenv';
dotenv.config();

import { ServiceNowAdapter } from './adapters/servicenow';
import { GeminiLLMClient } from './llm/llm_client';
import { ControlEffectivenessAgent, InherentAssessmentAgent, RiskControlMappingAgent } from './core/agents';
import { withTrace } from './core/observability';

// Instance ID to test
const instanceId = '01b116b883ae0790fba8c4e0deaad3d7';
console.log(`Starting assessment agents test for ServiceNow Instance: ${instanceId}`);

const adapter = new ServiceNowAdapter();
const llm = new GeminiLLMClient();

const agents = [
  { name: 'control-effectiveness', agent: new ControlEffectivenessAgent(adapter, llm) },
  { name: 'inherent-assessment', agent: new InherentAssessmentAgent(adapter, llm) },
  { name: 'risk-control-mapping', agent: new RiskControlMappingAgent(adapter, llm) },
];

(async () => {
  for (const { name, agent } of agents) {
    const t0 = Date.now();
    try {
      const result = await withTrace('run-agent', { platform: 'servicenow', agent: name, targetId: instanceId }, async () => {
        // Each agent class has an execute method
        return await (agent as any).execute(instanceId);
      });
      const duration = (Date.now() - t0) / 1000;
      console.log(`Agent '${name}' completed in ${duration.toFixed(3)} seconds`);
      console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error: any) {
      const duration = (Date.now() - t0) / 1000;
      console.error(`Agent '${name}' failed after ${duration.toFixed(3)} seconds`);
      console.error('Error:', error.message);
    }
    console.log('---');
  }
})();
