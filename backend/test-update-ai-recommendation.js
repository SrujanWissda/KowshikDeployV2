const axios = require('axios');
require('dotenv').config();

async function testUpdate() {
  const INSTANCE_URL = process.env.SALESFORCE_INSTANCE_URL;
  const CLIENT_ID = process.env.SALESFORCE_CLIENT_ID;
  const CLIENT_SECRET = process.env.SALESFORCE_CLIENT_SECRET;

  try {
    console.log('🔐 Getting token...');
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

    // Test: Try to update ai_recommendation__c field
    const riskId = 'a6lKW0000012kz5YAA';
    const testNarrative = 'TEST NARRATIVE - ' + new Date().toISOString();

    console.log('📝 Attempting to update ai_recommendation__c on grc__Risk__c...');
    const updateResponse = await axios.patch(
      `${INSTANCE_URL}/services/data/v65.0/sobjects/grc__Risk__c/${riskId}`,
      {
        ai_recommendation__c: testNarrative
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log('✅ Update successful!');
    console.log('Status:', updateResponse.status);
    console.log('Response:', updateResponse.data);

    // Verify the update
    console.log('\n📋 Verifying the update...');
    const verifyResponse = await axios.get(
      `${INSTANCE_URL}/services/data/v65.0/sobjects/grc__Risk__c/${riskId}?fields=ai_recommendation__c`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log('✅ Verified:');
    console.log('ai_recommendation__c:', verifyResponse.data.ai_recommendation__c);

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

testUpdate();
