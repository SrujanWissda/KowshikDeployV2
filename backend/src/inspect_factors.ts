import dotenv from 'dotenv';
dotenv.config();
import { ServiceNowAdapter } from './adapters/servicenow';

async function main() {
  const adapter = new ServiceNowAdapter('instance_002');
  const instanceId = '4d1d2ce5938b4bd085ebf24efaba1053';

  const inst = await adapter.getAssessmentInstance(instanceId);
  console.log('Instance:', inst);

  if (inst) {
    const risk = await adapter.getRisk(inst.riskSysId);
    console.log('Risk:', risk);

    const factors = await adapter.getAnswerableManualRows(inst.sysId);
    console.log(`Factors (${factors.length}):`, factors.map(f => ({ name: f.factorName, sysId: f.sysId, choices: f.choiceList })));
  }
}

main().catch(console.error);
