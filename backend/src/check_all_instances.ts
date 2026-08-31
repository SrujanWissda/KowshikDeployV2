import dotenv from 'dotenv';
dotenv.config();
import { ServiceNowAdapter } from './adapters/servicenow';

async function checkInstances() {
  const instances = ['instance_001', 'instance_002', 'instance_003'];
  for (const instName of instances) {
    console.log(`\n=== Testing ${instName} ===`);
    try {
      const adapter = new ServiceNowAdapter(instName);
      const finEvents = await (adapter as any).queryTable('sn_risk_advanced_event', {
        sysparm_limit: '5',
        sysparm_query: 'ORDERBYDESCsys_created_on'
      });
      console.log(`[${instName}] Successfully queried sn_risk_advanced_event. Found: ${finEvents?.length || 0} events`);
      if (finEvents && finEvents.length > 0) {
        console.log('Sample event names:', finEvents.map((e: any) => ({
          name: e.name?.value || e.name,
          loss: e.expected_loss?.value || e.expected_loss,
          created: e.sys_created_on?.value || e.sys_created_on
        })));
      }
    } catch (e: any) {
      console.error(`[${instName}] Error:`, e.message);
    }
  }
}

checkInstances().catch(console.error);
