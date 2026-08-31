import dotenv from 'dotenv';
dotenv.config();

import { ServiceNowAdapter } from './adapters/servicenow';

const instanceSysId = '3818156193438bd085ebf24efaba1006';

async function main() {
  const adapter = new ServiceNowAdapter('instance_002');

  // Try fetching as assessment instance first
  const inst = await adapter.getAssessmentInstance(instanceSysId);
  if (inst) {
    const risk = await adapter.getRisk(inst.riskSysId);
    console.log('=== Assessment Instance Found ===');
    console.log(`Instance Number: ${inst.number} (${inst.sysId})`);
    console.log(`Linked Risk Name: "${risk?.name}"`);
    console.log(`Risk Description: "${risk?.description}"`);
    console.log(`Entity: "${risk?.profileName}"`);
    console.log(`Risk sys_id: ${risk?.sysId}`);
    return;
  }

  // Try as a direct risk record
  const risk = await adapter.getRisk(instanceSysId);
  if (risk) {
    console.log('=== Risk Record Found ===');
    console.log(`Risk Name: "${risk.name}"`);
    console.log(`Risk Description: "${risk.description}"`);
    console.log(`Entity: "${risk.profileName}"`);
    console.log(`Risk sys_id: ${risk.sysId}`);
    return;
  }

  console.log('Record not found as assessment instance or risk on instance_002.');
}

main().catch(console.error);
