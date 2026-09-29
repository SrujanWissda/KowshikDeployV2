import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { instanceRegistry } from './core/instance-registry';
import { GeminiLLMClient, DeepInfraLLMClient } from './llm/llm_client';
import { RiskControlMappingAgent } from './core/agents';
import { VerificationAgent } from './core/verification_agent';

const riskSysId = 'bd0f658b931f0f5085ebf24efaba10c5';
const instanceId = 'instance_002';

async function main() {
  console.log(`[TEST] Starting Risk Control Mapping & Verification test...`);
  console.log(`[TEST] Target Instance: ${instanceId}`);
  console.log(`[TEST] Target Risk Sys ID: ${riskSysId}`);

  const adapter = instanceRegistry.getAdapter(instanceId);
  const producerLlm = new GeminiLLMClient();
  const verificationLlm = new DeepInfraLLMClient();

  console.log('\n--- Step 1: Running RiskControlMappingAgent ---');
  const agent = new RiskControlMappingAgent(adapter, producerLlm);
  const agentResult = await agent.execute(riskSysId);
  console.log('Agent Execution Result:', JSON.stringify(agentResult, null, 2));

  console.log('\n--- Step 2: Running VerificationAgent (GLM-4.7 on DeepInfra) ---');
  const verifier = new VerificationAgent(adapter, verificationLlm);
  const verifyResult = await verifier.verifyAgentRun('risk-control-mapping', riskSysId);
  console.log('Verification Result:', JSON.stringify(verifyResult, null, 2));
}

main().catch(err => {
  console.error('[TEST ERROR]', err);
  process.exit(1);
});
