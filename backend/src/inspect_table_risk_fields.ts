import dotenv from 'dotenv';
dotenv.config();

import { ServiceNowAdapter } from './adapters/servicenow';

async function main() {
  const adapter = new ServiceNowAdapter('instance_002');
  const tables = ['sn_risk_advanced_event', 'sn_compliance_exam', 'sn_grc_issue', 'sn_compliance_external_event'];

  for (const table of tables) {
    try {
      const rows = await (adapter as any).queryTable(table, { sysparm_limit: '1' });
      if (rows && rows.length > 0) {
        const keys = Object.keys(rows[0]);
        const riskFields = keys.filter(k => k.toLowerCase().includes('risk') || k.toLowerCase().includes('item') || k.toLowerCase().includes('entity') || k.toLowerCase().includes('profile'));
        console.log(`\nTable [${table}] columns count: ${keys.length}`);
        console.log(`Potential Risk/Entity linking fields in ${table}:`, riskFields);
      } else {
        console.log(`\nTable [${table}] returned 0 rows.`);
      }
    } catch (e: any) {
      console.log(`\nTable [${table}] error:`, e.message);
    }
  }
}

main().catch(console.error);
