// One-off CLI runner for the Universal Schema Discovery pipeline.
// Usage: npx ts-node src/run_discovery.ts "<platformName>" "<entityLabel>"
import dotenv from 'dotenv';
dotenv.config();
import { GeminiLLMClient } from './llm/llm_client';
import { GeminiEmbeddingsClient } from './llm/embeddings_client';
import { VectorStore } from './core/vector_store';
import { UniversalSchemaDiscoveryAgent } from './core/universal_schema_discovery_agent';
import { SalesforceDescribeConnector } from './adapters/connectors/salesforce_describe';

async function main() {
  const platformName = process.argv[2] || 'Salesforce GRC (Live Discovered)';
  const entityLabel = process.argv[3] || 'Business Unit';

  const connector = new SalesforceDescribeConnector(
    process.env.SALESFORCE_INSTANCE_URL || '',
    process.env.SALESFORCE_CLIENT_ID || '',
    process.env.SALESFORCE_CLIENT_SECRET || ''
  );
  if (!connector.isConfigured()) {
    throw new Error('Salesforce credentials not configured in .env');
  }

  const agent = new UniversalSchemaDiscoveryAgent(new GeminiLLMClient(), new GeminiEmbeddingsClient(), new VectorStore());
  const config = await agent.executeLive(platformName, connector, 'salesforce-soql', entityLabel);

  console.log('\n=== DISCOVERY COMPLETE ===');
  console.log(`Platform: ${config.platformName} | origin: ${config.origin} | validated: ${config.validation.validated}`);
  for (const t of config.tables) {
    console.log(`  ${t.sourceTableName} -> ${t.targetAgnosticModel} (${t.fieldMappings.length} fields, rel: ${Object.keys(t.relationships).join('/') || 'none'})`);
  }
}

main().catch(e => { console.error('DISCOVERY FAILED:', e.message); process.exit(1); });
