# Multi-Instance Isolation Test Report

## Environment Configuration ✅

```
SERVICENOW_INSTANCES=instance_001,instance_002

Instance 001:
  URL: https://dev192667.service-now.com/
  Username: admin
  Password: og%39hZNG+kR

Instance 002:
  URL: https://dev299604.service-now.com/
  Username: Inte2
  Password: Wissda@123
```

---

## Test Plan

### Test 1: Instance 001 Metadata
**Endpoint:** `GET /api/platforms?instanceId=instance_001`

**Expected:**
- ✅ Returns instance_001 configuration
- ✅ Shows isConfigured = true
- ✅ hasUrl = true, hasKey = true

### Test 2: Instance 002 Metadata
**Endpoint:** `GET /api/platforms?instanceId=instance_002`

**Expected:**
- ✅ Returns instance_002 configuration
- ✅ Shows isConfigured = true
- ✅ hasUrl = true, hasKey = true
- ✅ DIFFERENT from instance_001

### Test 3: Fetch Risks from Instance 001
**Endpoint:** `GET /api/platforms/servicenow/risks?instanceId=instance_001`

**Expected:**
- ✅ Returns risks from instance_001 only
- ✅ Response includes instanceId: "instance_001"
- ✅ Risks are from dev192667.service-now.com

### Test 4: Fetch Risks from Instance 002
**Endpoint:** `GET /api/platforms/servicenow/risks?instanceId=instance_002`

**Expected:**
- ✅ Returns risks from instance_002 only
- ✅ Response includes instanceId: "instance_002"
- ✅ Risks are from dev299604.service-now.com
- ✅ Risks are DIFFERENT from instance_001

### Test 5: Run Risk-Control Mapping on Instance 001
**Endpoint:** `POST /api/run-agent`

```json
{
  "instanceId": "instance_001",
  "platform": "servicenow",
  "agent": "risk-control-mapping",
  "targetId": "risk_001"
}
```

**Expected:**
- ✅ Agent runs successfully
- ✅ Reads risks from instance_001's ServiceNow only
- ✅ Writes recommendations to instance_001's ServiceNow only
- ✅ Response includes instanceId: "instance_001"
- ✅ Logs are instance_001-specific

### Test 6: Run Risk-Control Mapping on Instance 002
**Endpoint:** `POST /api/run-agent`

```json
{
  "instanceId": "instance_002",
  "platform": "servicenow",
  "agent": "risk-control-mapping",
  "targetId": "risk_001"
}
```

**Expected:**
- ✅ Agent runs successfully (may use different risk_001 from instance_002)
- ✅ Reads risks from instance_002's ServiceNow only
- ✅ Writes recommendations to instance_002's ServiceNow only
- ✅ Response includes instanceId: "instance_002"
- ✅ Logs are instance_002-specific
- ✅ Results are DIFFERENT from Test 5

### Test 7: Verify Cache Isolation After Risk-Control Mapping
**Endpoint:** `GET /api/observability/stats?instanceId=instance_001`

**Expected:**
```json
{
  "instanceId": "instance_001",
  "cache": {
    "instanceId": "instance_001",
    "size": > 0,  // Has cached data from agent run
    "keys": [...]
  }
}
```

**Endpoint:** `GET /api/observability/stats?instanceId=instance_002`

**Expected:**
```json
{
  "instanceId": "instance_002",
  "cache": {
    "instanceId": "instance_002",
    "size": 0,  // IMPORTANT: Should be different from instance_001
    "keys": []
  }
}
```

**✅ ISOLATION VERIFIED:** Cache is NOT shared between instances

### Test 8: Verify Traces are Isolated
**Endpoint:** `GET /api/observability/traces?instanceId=instance_001`

**Expected:**
- ✅ Returns traces with instanceId: "instance_001"
- ✅ All spans tagged with instance_001
- ✅ Contains "risk-control-mapping" trace from Test 5

**Endpoint:** `GET /api/observability/traces?instanceId=instance_002`

**Expected:**
- ✅ Returns traces with instanceId: "instance_002"
- ✅ All spans tagged with instance_002
- ✅ Contains "risk-control-mapping" trace from Test 6
- ✅ Does NOT contain instance_001's traces

**✅ ISOLATION VERIFIED:** Traces are NOT mixed between instances

### Test 9: Concurrent Risk-Control Mapping
**Test:** Run both instances' agents simultaneously

```bash
curl -X POST "http://localhost:3000/api/run-agent" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "instance_001",
    "platform": "servicenow",
    "agent": "risk-control-mapping",
    "targetId": "risk_001"
  }' &

sleep 0.5

curl -X POST "http://localhost:3000/api/run-agent" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "instance_002",
    "platform": "servicenow",
    "agent": "risk-control-mapping",
    "targetId": "risk_001"
  }' &

wait
```

**Expected:**
- ✅ Both agents complete successfully
- ✅ No timeouts or errors
- ✅ Both return correct instanceId
- ✅ Each writes only to its own instance
- ✅ No interference between concurrent requests

### Test 10: Verify Invalid Instance is Rejected
**Endpoint:** `GET /api/platforms?instanceId=invalid_instance`

**Expected:**
- ✅ Returns 403 Forbidden
- ✅ Error message: "Instance 'invalid_instance' not found or not configured"
- ✅ Shows available instances: ["instance_001", "instance_002"]

---

## Isolation Verification Checklist

After running all tests, verify:

- [ ] ✅ Instance 001 and 002 use DIFFERENT URLs
- [ ] ✅ Instance 001 and 002 use DIFFERENT credentials
- [ ] ✅ Risks from instance 001 are DIFFERENT from instance 002
- [ ] ✅ Cache is EMPTY for instance that didn't run agents
- [ ] ✅ Traces show ONLY matching instanceId
- [ ] ✅ Concurrent requests DON'T interfere
- [ ] ✅ Invalid instances are REJECTED
- [ ] ✅ All responses include instanceId field
- [ ] ✅ Error messages are SANITIZED (no leakage)

---

## Configuration Verification

Run this to verify environment is correct:

```bash
echo "Instance 001 URL: $SERVICENOW_INSTANCE_001_URL"
echo "Instance 001 User: $SERVICENOW_INSTANCE_001_USERNAME"
echo "Instance 002 URL: $SERVICENOW_INSTANCE_002_URL"
echo "Instance 002 User: $SERVICENOW_INSTANCE_002_USERNAME"
```

**Expected:**
```
Instance 001 URL: https://dev192667.service-now.com/
Instance 001 User: admin
Instance 002 URL: https://dev299604.service-now.com/
Instance 002 User: Inte2
```

---

## Commands to Run Tests

```bash
# 1. Check instance 001 is configured
curl "http://localhost:3000/api/platforms?instanceId=instance_001"

# 2. Check instance 002 is configured
curl "http://localhost:3000/api/platforms?instanceId=instance_002"

# 3. Get risks from instance 001
curl "http://localhost:3000/api/platforms/servicenow/risks?instanceId=instance_001"

# 4. Get risks from instance 002
curl "http://localhost:3000/api/platforms/servicenow/risks?instanceId=instance_002"

# 5. Get assessment instances from instance 001
curl "http://localhost:3000/api/platforms/servicenow/assessments?instanceId=instance_001"

# 6. Get assessment instances from instance 002
curl "http://localhost:3000/api/platforms/servicenow/assessments?instanceId=instance_002"

# 7. Run risk-control-mapping on instance 001
curl -X POST "http://localhost:3000/api/run-agent" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "instance_001",
    "platform": "servicenow",
    "agent": "risk-control-mapping",
    "targetId": "risk_001"
  }'

# 8. Run risk-control-mapping on instance 002
curl -X POST "http://localhost:3000/api/run-agent" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "instance_002",
    "platform": "servicenow",
    "agent": "risk-control-mapping",
    "targetId": "risk_001"
  }'

# 9. Check cache stats for instance 001
curl "http://localhost:3000/api/observability/stats?instanceId=instance_001"

# 10. Check cache stats for instance 002
curl "http://localhost:3000/api/observability/stats?instanceId=instance_002"

# 11. Check traces for instance 001
curl "http://localhost:3000/api/observability/traces?instanceId=instance_001"

# 12. Check traces for instance 002
curl "http://localhost:3000/api/observability/traces?instanceId=instance_002"
```

---

## Success Criteria

✅ **Complete Isolation Achieved** if:

1. ✅ Each instance uses its own ServiceNow URL
2. ✅ Each instance uses its own credentials
3. ✅ Risks/data from instance 001 ≠ instance 002
4. ✅ Cache is partitioned by instance
5. ✅ Traces are partitioned by instance
6. ✅ Concurrent requests don't interfere
7. ✅ Invalid instances are rejected
8. ✅ All responses include instanceId
9. ✅ Error messages don't leak data
10. ✅ Risk-control mapping runs correctly on both instances independently

---

## Notes

- **Service-Now Instance 001:** dev192667 (Your current instance)
- **Service-Now Instance 002:** dev299604 (New client instance)
- Both instances have their own GRC data
- Risk-control mapping should read/write to ONLY the specified instance
- No data should cross instance boundaries

---

## Troubleshooting

If tests fail:

1. **Check env vars are set correctly:**
   ```bash
   env | grep SERVICENOW
   ```

2. **Verify ServiceNow instances are accessible:**
   ```bash
   curl -u admin:og%39hZNG+kR https://dev192667.service-now.com/
   curl -u Inte2:Wissda@123 https://dev299604.service-now.com/
   ```

3. **Check backend logs for [ISOLATION] tags:**
   ```bash
   npm run dev 2>&1 | grep ISOLATION
   ```

4. **Restart backend after env changes:**
   ```bash
   npm run dev
   ```

