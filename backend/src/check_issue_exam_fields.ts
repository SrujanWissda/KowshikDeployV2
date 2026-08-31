import dotenv from 'dotenv';
dotenv.config();

import { ServiceNowAdapter } from './adapters/servicenow';

async function main() {
  const adapter = new ServiceNowAdapter('instance_002');
  const rows = await (adapter as any).queryTable('sn_grc_issue', { sysparm_limit: '1' });
  if (rows && rows.length > 0) {
    const keys = Object.keys(rows[0]);
    const examFields = keys.filter(k => k.toLowerCase().includes('exam') || k.toLowerCase().includes('source') || k.toLowerCase().includes('audit') || k.toLowerCase().includes('parent') || k.toLowerCase().includes('engagement'));
    console.log('Exam/source related fields in sn_grc_issue:', examFields);
  }
}

main().catch(console.error);
