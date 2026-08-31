import dotenv from 'dotenv';
dotenv.config();
import { ServiceNowAdapter } from './adapters/servicenow';

async function inspectFinEvents() {
  const adapter = new ServiceNowAdapter('instance_002');
  const finEvents = await (adapter as any).queryTable('sn_risk_advanced_event', {
    sysparm_limit: '50',
    sysparm_query: 'expected_loss>0^ORnet_loss>0^ORactual_loss>0'
  });
  console.log(`Found ${finEvents?.length || 0} financial events with loss > 0:`);
  for (const e of finEvents || []) {
    console.log({
      sys_id: e.sys_id?.value || e.sys_id,
      name: e.name?.value || e.name,
      expected_loss: e.expected_loss?.value || e.expected_loss,
      net_loss: e.net_loss?.value || e.net_loss,
      actual_loss: e.actual_loss?.value || e.actual_loss,
      description: e.description?.value || e.description,
      risk: e.risk?.value || e.risk
    });
  }
}

inspectFinEvents().catch(console.error);
