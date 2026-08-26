#!/bin/bash
set -e

VERCEL_URL="https://ema-agents.vercel.app"
RECORD_ID="a6lKW0000012kyvYAA"

echo "========== Testing with updated Salesforce adapter =========="
echo "Testing EMA audit trail creation..."
echo ""

# Test inherent assessment (should create EMA audit trail)
echo "1. Testing Inherent Assessment..."
curl -s -X POST "${VERCEL_URL}/api/run-agent" \
  -H "Content-Type: application/json" \
  -d "{
    \"platform\": \"Salesforce GRC (Live Discovered)\",
    \"agent\": \"inherent-assessment\",
    \"targetId\": \"${RECORD_ID}\"
  }" | jq . > /tmp/inherent_response.json 2>&1 || echo "Note: jq not available, saved raw response"

echo ""
echo "2. Testing Control Effectiveness..."
curl -s -X POST "${VERCEL_URL}/api/run-agent" \
  -H "Content-Type: application/json" \
  -d "{
    \"platform\": \"Salesforce GRC (Live Discovered)\",
    \"agent\": \"control-effectiveness\",
    \"targetId\": \"${RECORD_ID}\"
  }" | jq . > /tmp/control_response.json 2>&1 || echo "Note: jq not available, saved raw response"

echo ""
echo "========== Test Complete =========="
echo "Check Salesforce org for Risk__EMA_Audit_Trail__c records"
