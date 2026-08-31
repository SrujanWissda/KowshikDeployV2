import dotenv from 'dotenv';
dotenv.config();
import { ServiceNowAdapter } from './adapters/servicenow';

async function inspectRecentRecords() {
  const adapter = new ServiceNowAdapter('instance_002');
  console.log('=== Inspecting recent records on instance_002 ===\n');

  // 1. Financial Events
  console.log('--- 1. Recent Financial Risk Events (sn_risk_advanced_event) ---');
  const finEvents = await (adapter as any).queryTable('sn_risk_advanced_event', {
    sysparm_limit: '15',
    sysparm_query: 'ORDERBYDESCsys_created_on'
  });
  for (const e of finEvents || []) {
    console.log({
      sys_id: e.sys_id?.value || e.sys_id,
      name: e.name?.value || e.name,
      description: e.description?.value || e.description,
      expected_loss: e.expected_loss?.value || e.expected_loss,
      impact: e.impact?.display_value || e.impact?.value || e.impact,
      risk: e.risk?.value || e.risk,
      sys_created_on: e.sys_created_on?.value || e.sys_created_on
    });
  }

  // 2. Compliance Exams
  console.log('\n--- 2. Recent Compliance Exams (sn_compliance_exam) ---');
  const exams = await (adapter as any).queryTable('sn_compliance_exam', {
    sysparm_limit: '10',
    sysparm_query: 'ORDERBYDESCsys_created_on'
  });
  for (const ex of exams || []) {
    console.log({
      sys_id: ex.sys_id?.value || ex.sys_id,
      u_name: ex.u_name?.value || ex.u_name,
      u_description: ex.u_description?.value || ex.u_description,
      u_regulator_name: ex.u_regulator_name?.value || ex.u_regulator_name,
      u_formal_findings: ex.u_formal_findings?.value || ex.u_formal_findings,
      u_informal_observations: ex.u_informal_observations?.value || ex.u_informal_observations,
      u_status: ex.u_status?.value || ex.u_status,
      sys_created_on: ex.sys_created_on?.value || ex.sys_created_on
    });
  }

  // 3. Incidents
  console.log('\n--- 3. Recent Incidents (incident) ---');
  const incidents = await (adapter as any).queryTable('incident', {
    sysparm_limit: '10',
    sysparm_query: 'ORDERBYDESCsys_created_on'
  });
  for (const inc of incidents || []) {
    console.log({
      sys_id: inc.sys_id?.value || inc.sys_id,
      number: inc.number?.value || inc.number,
      short_description: inc.short_description?.value || inc.short_description,
      description: inc.description?.value || inc.description,
      category: inc.category?.value || inc.category,
      impact: inc.impact?.value || inc.impact,
      affected_records: inc.affected_records?.value || inc.affected_records,
      sys_created_on: inc.sys_created_on?.value || inc.sys_created_on
    });
  }

  // 4. External Events
  console.log('\n--- 4. Recent External Events (sn_compliance_external_event) ---');
  const extEvents = await (adapter as any).queryTable('sn_compliance_external_event', {
    sysparm_limit: '10',
    sysparm_query: 'ORDERBYDESCsys_created_on'
  });
  for (const ext of extEvents || []) {
    console.log({
      sys_id: ext.sys_id?.value || ext.sys_id,
      u_name: ext.u_name?.value || ext.u_name,
      u_media_mention: ext.u_media_mention?.value || ext.u_media_mention,
      u_sentiment: ext.u_sentiment?.value || ext.u_sentiment,
      u_impact_scope: ext.u_impact_scope?.value || ext.u_impact_scope,
      sys_created_on: ext.sys_created_on?.value || ext.sys_created_on
    });
  }
}

inspectRecentRecords().catch(console.error);
