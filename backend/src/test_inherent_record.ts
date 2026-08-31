import dotenv from 'dotenv';
dotenv.config();

import { ServiceNowAdapter } from './adapters/servicenow';
import { GeminiLLMClient } from './llm/llm_client';
import { InherentAssessmentAgent } from './core/agents';

const recordId = process.argv[2] || '8375da6193cb8bd085ebf24efaba106f';

async function main() {
  console.log(`=== Running Inherent Assessment for record: ${recordId} on instance_002 ===\n`);

  const adapter = new ServiceNowAdapter('instance_002');
  const llm = new GeminiLLMClient();

  const inst = await adapter.getAssessmentInstance(recordId);
  if (!inst) {
    console.error('Assessment instance not found!');
    return;
  }

  const risk = await adapter.getRisk(inst.riskSysId);
  console.log(`Instance: ${inst.number} (${inst.sysId})`);
  console.log(`Linked Risk: "${risk?.name}" (${risk?.sysId})`);
  console.log(`Entity: "${risk?.profileName}" (${risk?.profileSysId})`);

  console.log('\n--- Fetching & Verifying All Records Across ServiceNow Tables ---');
  const finEvents = await adapter.getAllFinancialRiskEvents();
  console.log(`✅ Financial Risk Events (sn_risk_advanced_event): ${finEvents.length} records retrieved`);
  console.log('   Sample:', finEvents.slice(0, 3).map(e => `${e.name}: $${e.expected_loss} (Impact: ${e.impact})`));

  const exams = await adapter.getAllComplianceExams();
  console.log(`✅ Compliance Exams (sn_compliance_exam): ${exams.length} records retrieved`);
  console.log('   Sample:', exams.slice(0, 3).map(e => `${e.name} (${e.regulator_name}, ${e.status})`));

  const grcIssues = await adapter.getAllGrcIssues();
  console.log(`✅ GRC Issues (sn_grc_issue): ${grcIssues.length} records retrieved`);
  console.log('   Sample:', grcIssues.slice(0, 3).map(i => `${i.name} (Severity: ${i.severity})`));

  const incidents = await adapter.getAllIncidents();
  console.log(`✅ Incidents (incident): ${incidents.length} records retrieved`);
  console.log('   Sample:', incidents.slice(0, 3).map(i => `${i.name} (Type: ${i.incident_type})`));

  const extEvents = await adapter.getAllExternalEvents();
  console.log(`✅ External Events (sn_compliance_external_event): ${extEvents.length} records retrieved`);
  console.log('   Sample:', extEvents.slice(0, 3).map(e => `${e.name} (Mentions: ${e.media_mention_count}, Sentiment: ${e.sentiment})`));

  console.log('\n--- Executing InherentAssessmentAgent ---');
  const agent = new InherentAssessmentAgent(adapter, llm);
  const t0 = Date.now();
  const result = await agent.execute(recordId);
  const duration = ((Date.now() - t0) / 1000).toFixed(2);

  console.log(`\n=== Execution Completed in ${duration}s ===`);
  console.log('Success:', result.success);
  console.log('Message:', result.message);
  console.log('\n--- Factor Ratings & Evidence Breakdown ---');
  for (const [idx, detail] of result.details.entries()) {
    console.log(`\n[${idx + 1}] Factor: ${detail.factor}`);
    console.log(`    Rating: ${detail.rating} (Score: ${detail.score}) | Verified: ${detail.verified}`);
    console.log(`    Justification: ${detail.justification.replace(/\n/g, '\n    ')}`);
  }
}

main().catch(console.error);
