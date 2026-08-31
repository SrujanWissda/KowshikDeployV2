import dotenv from 'dotenv';
dotenv.config();

import { ServiceNowAdapter } from './adapters/servicenow';

async function main() {
  const adapter = new ServiceNowAdapter('instance_002');

  // Test 1: sn_risk_advanced_event
  try {
    const r1 = await (adapter as any).queryTable('sn_risk_advanced_event', {
      sysparm_fields: 'sys_id,name',
      sysparm_query: 'risk_referenceISEMPTY^ORDERBYDESCsys_created_on',
      sysparm_limit: '5'
    });
    console.log('sn_risk_advanced_event risk_referenceISEMPTY count:', r1.length);
  } catch (e: any) {
    console.log('sn_risk_advanced_event error:', e.message);
  }

  // Test 2: sn_compliance_exam
  try {
    const r2 = await (adapter as any).queryTable('sn_compliance_exam', {
      sysparm_fields: 'sys_id,name',
      sysparm_query: 'u_riskISEMPTY^ORDERBYDESCsys_created_on',
      sysparm_limit: '5'
    });
    console.log('sn_compliance_exam u_riskISEMPTY count:', r2.length);
  } catch (e: any) {
    console.log('sn_compliance_exam error:', e.message);
  }

  // Test 3: sn_grc_issue
  try {
    const r3 = await (adapter as any).queryTable('sn_grc_issue', {
      sysparm_fields: 'sys_id,name',
      sysparm_query: 'itemISEMPTY^ORDERBYDESCsys_created_on',
      sysparm_limit: '5'
    });
    console.log('sn_grc_issue itemISEMPTY count:', r3.length);
  } catch (e: any) {
    console.log('sn_grc_issue error:', e.message);
  }

  // Test 4: sn_compliance_external_event
  try {
    const r4 = await (adapter as any).queryTable('sn_compliance_external_event', {
      sysparm_fields: 'sys_id,name',
      sysparm_query: 'u_riskISEMPTY^ORDERBYDESCsys_created_on',
      sysparm_limit: '5'
    });
    console.log('sn_compliance_external_event u_riskISEMPTY count:', r4.length);
  } catch (e: any) {
    console.log('sn_compliance_external_event error:', e.message);
  }
}

main().catch(console.error);
