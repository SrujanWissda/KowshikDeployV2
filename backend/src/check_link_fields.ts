import dotenv from 'dotenv';
dotenv.config();

import { ServiceNowAdapter } from './adapters/servicenow';

const RISK_SYS_ID = 'fcdb916993438bd085ebf24efaba10d9'; // RASMT00100123's risk

async function main() {
  const adapter = new ServiceNowAdapter('instance_002');
  const q = (table: string, params: any) => (adapter as any).queryTable(table, params);

  console.log(`\n=== Testing all fixed direct-link queries for risk ${RISK_SYS_ID} ===\n`);

  // 1. Test M2M event join table (new fix)
  console.log('[1] sn_risk_advanced_m2m_event_risk (Risk Events join) ...');
  try {
    const joinRows = await q('sn_risk_advanced_m2m_event_risk', {
      sysparm_fields: 'sys_id,risk,risk_event',
      sysparm_query: `risk=${RISK_SYS_ID}`,
      sysparm_limit: '20'
    });
    console.log(`  Found ${joinRows.length} linked event rows (UI shows 8)`);
    if (joinRows.length > 0) {
      const eventIds = joinRows.map((r: any) => {
        const re = r.risk_event;
        return typeof re === 'object' ? re?.value : re;
      }).filter(Boolean);
      console.log(`  Event sys_ids: ${eventIds.join(', ')}`);
      
      // Fetch the actual events
      if (eventIds.length > 0) {
        const events = await q('sn_risk_advanced_event', {
          sysparm_fields: 'sys_id,name,expected_loss,impact',
          sysparm_query: `sys_idIN${eventIds.join(',')}`,
          sysparm_limit: '20'
        });
        console.log(`  Fetched ${events.length} actual event records:`);
        for (const e of events) {
          const name = typeof e.name === 'object' ? e.name?.display_value : e.name;
          const loss = typeof e.expected_loss === 'object' ? e.expected_loss?.value : e.expected_loss;
          console.log(`    - "${name}" loss=$${loss}`);
        }
      }
    }
  } catch (e: any) { console.log(`  ERROR: ${e.message?.substring(0, 150)}`); }

  // 2. Test incident u_risk (new fix)
  console.log('\n[2] incident.u_risk ...');
  try {
    const rows = await q('incident', {
      sysparm_fields: 'sys_id,number,short_description,u_risk,impact',
      sysparm_query: `u_risk=${RISK_SYS_ID}`,
      sysparm_limit: '20'
    });
    console.log(`  Found ${rows.length} directly linked incidents (UI shows 12)`);
    for (const r of rows.slice(0, 5)) {
      const num = typeof r.number === 'object' ? r.number?.display_value : r.number;
      const desc = typeof r.short_description === 'object' ? r.short_description?.display_value : r.short_description;
      console.log(`    - ${num}: "${desc}"`);
    }
  } catch (e: any) { console.log(`  ERROR: ${e.message?.substring(0, 150)}`); }

  // 3. Verify compliance exam (already working)
  console.log('\n[3] sn_compliance_exam.u_risk ...');
  try {
    const rows = await q('sn_compliance_exam', {
      sysparm_fields: 'sys_id,u_name,u_risk',
      sysparm_query: `u_risk=${RISK_SYS_ID}`,
      sysparm_limit: '20'
    });
    console.log(`  Found ${rows.length} directly linked exams (UI shows 8) ✅`);
    const examIds = rows.map((r: any) => typeof r.sys_id === 'object' ? r.sys_id?.value : r.sys_id);
    
    // Fetch issues from those exams
    if (examIds.length > 0) {
      const examQuery = examIds.map((eid: string) => `u_exam=${eid}^ORparent=${eid}`).join('^OR');
      const issues = await q('sn_grc_issue', {
        sysparm_fields: 'sys_id,short_description,u_exam,parent',
        sysparm_query: examQuery,
        sysparm_limit: '20'
      });
      console.log(`  Found ${issues.length} exam-linked issues:`);
      for (const i of issues.slice(0, 5)) {
        const desc = typeof i.short_description === 'object' ? i.short_description?.display_value : i.short_description;
        console.log(`    - "${desc}"`);
      }
    }
  } catch (e: any) { console.log(`  ERROR: ${e.message?.substring(0, 150)}`); }

  // 4. External events (already working)
  console.log('\n[4] sn_compliance_external_event.u_risk ...');
  try {
    const rows = await q('sn_compliance_external_event', {
      sysparm_fields: 'sys_id,u_name,u_risk',
      sysparm_query: `u_risk=${RISK_SYS_ID}`,
      sysparm_limit: '20'
    });
    console.log(`  Found ${rows.length} directly linked external events (UI shows 12) ✅`);
    for (const r of rows.slice(0, 3)) {
      const name = typeof r.u_name === 'object' ? r.u_name?.display_value : r.u_name;
      console.log(`    - "${name}"`);
    }
  } catch (e: any) { console.log(`  ERROR: ${e.message?.substring(0, 150)}`); }

  console.log('\nDone.');
}

main().catch(console.error);
