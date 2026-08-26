// Quick discovery script to find Ema_Audit_Trail__c fields in Salesforce
const axios = require('axios');
require('dotenv').config();

async function discoverEmaFields() {
  const INSTANCE_URL = process.env.SALESFORCE_INSTANCE_URL;
  const CLIENT_ID = process.env.SALESFORCE_CLIENT_ID;
  const CLIENT_SECRET = process.env.SALESFORCE_CLIENT_SECRET;

  if (!INSTANCE_URL || !CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ Missing Salesforce credentials in .env');
    process.exit(1);
  }

  try {
    // Get OAuth token
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
    console.log('✅ Authenticated successfully\n');

    // Describe Ema_Audit_Trail__c object
    console.log('📋 Describing Ema_Audit_Trail__c object...\n');
    const describeResponse = await axios.get(
      `${INSTANCE_URL}/services/data/v60.0/sobjects/Ema_Audit_Trail__c/describe`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const describe = describeResponse.data;
    console.log(`Object: ${describe.name}`);
    console.log(`Label: ${describe.label}`);
    console.log(`Total Fields: ${describe.fields.length}\n`);

    console.log('FIELDS:\n');
    console.log('Field Name | Type | Creatable | Updateable | Length');
    console.log('-'.repeat(80));

    describe.fields.forEach(field => {
      const type = field.type.padEnd(15);
      const creatable = String(field.createable).padEnd(10);
      const updateable = String(field.updateable).padEnd(10);
      const length = field.length || '';
      console.log(`${field.name.padEnd(40)} | ${type} | ${creatable} | ${updateable} | ${length}`);
    });

    console.log('\n✅ SUCCESS - Copy the field names above to update the Salesforce adapter');

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    process.exit(1);
  }
}

discoverEmaFields();
