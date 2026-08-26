const axios = require('axios');
require('dotenv').config();

async function discoverRiskFields() {
  const INSTANCE_URL = process.env.SALESFORCE_INSTANCE_URL;
  const CLIENT_ID = process.env.SALESFORCE_CLIENT_ID;
  const CLIENT_SECRET = process.env.SALESFORCE_CLIENT_SECRET;

  if (!INSTANCE_URL || !CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ Missing Salesforce credentials');
    process.exit(1);
  }

  try {
    console.log('🔐 Authenticating with Salesforce...');
    const tokenResponse = await axios.post(
      `${INSTANCE_URL}/services/oauth2/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const token = tokenResponse.data.access_token;
    console.log('✅ Authenticated\n');

    // Query for grc__Risk__c fields
    console.log('📋 Discovering grc__Risk__c object...\n');
    const riskResponse = await axios.get(
      `${INSTANCE_URL}/services/data/v60.0/sobjects/grc__Risk__c/describe`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const riskFields = riskResponse.data.fields;
    console.log('Fields on grc__Risk__c:\n');
    
    // Filter for recommendation/narrative fields
    const relevantFields = riskFields.filter(f => 
      f.name.toLowerCase().includes('recommendation') ||
      f.name.toLowerCase().includes('narrative') ||
      f.name.toLowerCase().includes('mapping') ||
      f.name.toLowerCase().includes('control') ||
      f.name.toLowerCase().includes('ai_') ||
      f.name.toLowerCase().includes('ema')
    );

    console.log('Recommendation/Narrative/AI Fields:');
    console.log('─'.repeat(80));
    relevantFields.forEach(field => {
      const type = field.type.padEnd(15);
      const length = field.length ? `${field.length}` : '-';
      console.log(`${field.name.padEnd(50)} | ${type} | ${length}`);
    });

    console.log('\n\nAll Fields on grc__Risk__c (full list):');
    console.log('─'.repeat(80));
    riskFields.forEach(field => {
      const type = field.type.padEnd(15);
      const length = field.length ? `${field.length}` : '-';
      if (field.updateable) {
        console.log(`${field.name.padEnd(50)} | ${type} | ${length}`);
      }
    });

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    process.exit(1);
  }
}

discoverRiskFields();
