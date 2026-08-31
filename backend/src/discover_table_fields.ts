import dotenv from 'dotenv';
dotenv.config();
import { ServiceNowAdapter } from './adapters/servicenow';

async function main() {
  const adapter = new ServiceNowAdapter('instance_002');
  console.log('Discovering actual columns returned from ServiceNow tables on instance_002:\n');

  const tables = [
    'sn_risk_advanced_event',
    'sn_compliance_exam',
    'sn_grc_issue',
    'incident',
    'sn_compliance_external_event'
  ];

  for (const table of tables) {
    try {
      const records = await (adapter as any).queryTable(table, { sysparm_limit: '1' });
      if (records && records.length > 0) {
        console.log(`=== TABLE: ${table} ===`);
        console.log('Available keys:', Object.keys(records[0]));
        console.log('Sample record (first 5 fields):', Object.entries(records[0]).slice(0, 8));
      } else {
        console.log(`=== TABLE: ${table} (0 records returned) ===`);
      }
    } catch (e: any) {
      console.error(`Error querying ${table}:`, e.message);
    }
    console.log('\n');
  }
}

main().catch(console.error);
