# Isolation Verification Checklist

## Quick Verification (5 minutes)

Run these commands to verify complete isolation is working:

### 1. Check Environment Configuration
```bash
echo "SERVICENOW_INSTANCES = $SERVICENOW_INSTANCES"
echo "Instance 001 URL = $SERVICENOW_INSTANCE_001_URL"
echo "Instance 002 URL = $SERVICENOW_INSTANCE_002_URL"
```

**Expected:**
```
SERVICENOW_INSTANCES = instance_001,instance_002
Instance 001 URL = https://client1.service-now.com
Instance 002 URL = https://client2.service-now.com
```

### 2. Verify Invalid Instance is Rejected
```bash
curl -X GET "http://localhost:3000/api/platforms?instanceId=invalid" \
  -H "Content-Type: application/json"
```

**Expected Response (403):**
```json
{
  "success": false,
  "error": "Instance 'invalid' not found or not configured.",
  "availableInstances": ["instance_001", "instance_002"]
}
```

### 3. Verify Instance 001 is Configured
```bash
curl -X GET "http://localhost:3000/api/platforms?instanceId=instance_001" \
  -H "Content-Type: application/json"
```

**Expected Response (200):**
```json
{
  "instanceId": "instance_001",
  "instance": {
    "instanceId": "instance_001",
    "isConfigured": true,
    "hasUrl": true,
    "hasKey": true
  },
  "platforms": [...],
  "agents": [...]
}
```

### 4. Verify Instance 002 is Configured
```bash
curl -X GET "http://localhost:3000/api/platforms?instanceId=instance_002" \
  -H "Content-Type: application/json"
```

**Expected Response (200):**
Same structure but with `instanceId: "instance_002"`

### 5. Verify Traces are Instance-Scoped

First, run an agent for instance_001:
```bash
curl -X POST "http://localhost:3000/api/run-agent" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "instance_001",
    "platform": "servicenow",
    "agent": "control-effectiveness",
    "targetId": "inst_301"
  }'
```

Then check traces for instance_001:
```bash
curl -X GET "http://localhost:3000/api/observability/traces?instanceId=instance_001" \
  -H "Content-Type: application/json"
```

**Expected:**
- Response includes traces with `instanceId: "instance_001"`
- All spans are tagged with instance_001

Now check traces for instance_002:
```bash
curl -X GET "http://localhost:3000/api/observability/traces?instanceId=instance_002" \
  -H "Content-Type: application/json"
```

**Expected:**
- Response is empty or contains ONLY instance_002's traces
- Does NOT include instance_001's traces from previous agent run
- **CRITICAL:** If you see instance_001's traces here, isolation is broken

### 6. Verify Cache is Instance-Scoped

Check cache stats for instance_001 after running agent:
```bash
curl -X GET "http://localhost:3000/api/observability/stats?instanceId=instance_001" \
  -H "Content-Type: application/json"
```

**Expected:**
```json
{
  "success": true,
  "instanceId": "instance_001",
  "cache": {
    "instanceId": "instance_001",
    "size": 1,  // At least 1 entry cached
    "keys": ["control_101"]  // or similar
  }
}
```

Now check cache for instance_002:
```bash
curl -X GET "http://localhost:3000/api/observability/stats?instanceId=instance_002" \
  -H "Content-Type: application/json"
```

**Expected:**
```json
{
  "success": true,
  "instanceId": "instance_002",
  "cache": {
    "instanceId": "instance_002",
    "size": 0,  // EMPTY - not affected by instance_001's cache
    "keys": []
  }
}
```

**CRITICAL:** If instance_002 shows the same cache keys as instance_001, isolation is broken.

---

## Deep Verification (20 minutes)

### 1. Concurrent Request Test

Open two terminals and run simultaneously:

**Terminal 1 - Instance 001:**
```bash
curl -X POST "http://localhost:3000/api/run-agent" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "instance_001",
    "platform": "servicenow",
    "agent": "control-effectiveness",
    "targetId": "inst_301"
  }'
```

**Terminal 2 - Instance 002 (run at same time):**
```bash
curl -X POST "http://localhost:3000/api/run-agent" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "instance_002",
    "platform": "servicenow",
    "agent": "inherent-assessment",
    "targetId": "inst_302"
  }'
```

**Expected:**
- Both complete successfully
- No `429 Too Many Requests` errors
- Both return data (not blocked by each other)
- Logs show separate `instanceId` tags: `[ISOLATION] POST /api/run-agent from instance 'instance_001'` and `instance_002`

### 2. Error Message Isolation Test

Stop the backend server (simulating connectivity issue).

Try to query instance_001:
```bash
curl -X GET "http://localhost:3000/api/platforms/servicenow/risks?instanceId=instance_001"
```

**Expected Error Message:**
```json
{
  "success": false,
  "error": "[ISOLATION] Instance 'instance_001' Failed to fetch risks for instance 'instance_001'",
  "instanceId": "instance_001"
}
```

**CRITICAL:** Error should NOT include:
- ❌ Other instance's URLs
- ❌ Full stack traces
- ❌ Connection details
- ❌ Any instance_002 data

Try to query instance_002:
```bash
curl -X GET "http://localhost:3000/api/platforms/servicenow/risks?instanceId=instance_002"
```

**Expected Error Message:**
```json
{
  "success": false,
  "error": "[ISOLATION] Instance 'instance_002' Failed to fetch risks for instance 'instance_002'",
  "instanceId": "instance_002"
}
```

**CRITICAL:** instance_002's error should reference instance_002, NOT instance_001

### 3. Adapter Credential Isolation Test

Add debug logging to verify adapters have correct credentials:

Edit `backend/src/core/instance-registry.ts` and add:
```typescript
getAdapter(instanceId: string): ServiceNowAdapter {
  // ... existing code ...
  if (!this.adapters.has(instanceId)) {
    const adapter = new ServiceNowAdapter(instanceId, config.url, config.key);
    console.log(`[InstanceRegistry] Instance ${instanceId} URL=${config.url}`);
    this.adapters.set(instanceId, adapter);
  }
  return this.adapters.get(instanceId)!;
}
```

Restart backend and check logs:
```
[InstanceRegistry] Instance instance_001 URL=https://client1.service-now.com
[InstanceRegistry] Instance instance_002 URL=https://client2.service-now.com
```

**CRITICAL:** Each instance MUST have different URL.

### 4. Request Validation Test

Try to send request without instanceId:
```bash
curl -X POST "http://localhost:3000/api/run-agent" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "servicenow",
    "agent": "control-effectiveness",
    "targetId": "inst_301"
  }'
```

**Expected Response (403):**
```json
{
  "success": false,
  "error": "Instance 'default' not found or not configured.",
  "availableInstances": ["instance_001", "instance_002"]
}
```

(Unless "default" is explicitly configured)

### 5. Frontend Integration Test

Update `frontend/app.js` to include instance selector:

```javascript
const INSTANCES = [
  { id: 'instance_001', label: 'Client 1' },
  { id: 'instance_002', label: 'Client 2' }
];

let selectedInstance = 'instance_001';

// When running agent
async function runAgent(agent, targetId) {
  const response = await fetch('/api/run-agent', {
    method: 'POST',
    body: JSON.stringify({
      instanceId: selectedInstance,  // ✅ MUST send
      platform: 'servicenow',
      agent,
      targetId
    })
  });
  const result = await response.json();
  console.log('Executed on instance:', result.instanceId);
  // Verify response.instanceId matches selectedInstance
}
```

**Test Steps:**
1. Select instance_001 from dropdown
2. Run agent
3. Verify result.instanceId === 'instance_001'
4. Select instance_002 from dropdown
5. Run agent
6. Verify result.instanceId === 'instance_002'
7. Switch back to instance_001
8. Verify risks are from instance_001 (different from instance_002)

---

## Automated Test Suite (45 minutes)

Create `tests/isolation.test.ts`:

```typescript
describe('Multi-Instance Isolation', () => {
  
  test('Instance 001 and 002 have different URLs', () => {
    const adapter001 = instanceRegistry.getAdapter('instance_001');
    const adapter002 = instanceRegistry.getAdapter('instance_002');
    
    expect(adapter001.getInstanceUrl())
      .not.toBe(adapter002.getInstanceUrl());
  });
  
  test('Cache is not shared between instances', () => {
    const cache001 = cacheService.get('instance_001', 'test_key');
    const cache002 = cacheService.get('instance_002', 'test_key');
    
    expect(cache001).not.toBe(cache002);
  });
  
  test('Traces are partitioned by instance', () => {
    obsService.startTrace('instance_001', 'test');
    obsService.startTrace('instance_002', 'test');
    
    const traces001 = obsService.getTracesForInstance('instance_001');
    const traces002 = obsService.getTracesForInstance('instance_002');
    
    // Verify they have different trace IDs
    expect(traces001[0].traceId)
      .not.toBe(traces002[0].traceId);
  });
  
  test('Concurrent requests do not collide', async () => {
    const result1 = runAgent('instance_001', 'control-effectiveness');
    const result2 = runAgent('instance_002', 'inherent-assessment');
    
    const [res1, res2] = await Promise.all([result1, result2]);
    
    expect(res1.instanceId).toBe('instance_001');
    expect(res2.instanceId).toBe('instance_002');
    expect(res1.result).not.toEqual(res2.result);
  });
});
```

Run tests:
```bash
npm test
```

All tests should pass.

---

## Production Checklist

Before deploying to production:

- [ ] ✅ Run all 5 quick verification tests
- [ ] ✅ Run concurrent request test
- [ ] ✅ Verify error message isolation
- [ ] ✅ Check adapter credential logging
- [ ] ✅ Test request validation
- [ ] ✅ Test frontend instance selector
- [ ] ✅ Run automated test suite
- [ ] ✅ Review logs for `[ISOLATION]` tags
- [ ] ✅ Verify all responses include `instanceId`
- [ ] ✅ Monitor for any cross-instance data in traces
- [ ] ✅ Confirm frontend sends `instanceId` in all requests
- [ ] ✅ Test with real clients if possible
- [ ] ✅ Document instance IDs and URLs in runbooks

---

## Debugging Guide

### Symptom: Instance 1 reads Instance 2's data

**Diagnosis:**
1. Check if instanceId is being passed to adapter: `instanceRegistry.getAdapter(instanceId)`
2. Verify adapter constructor receives correct URL
3. Check ServiceNow API key for instance

**Fix:**
1. Ensure frontend sends correct instanceId
2. Verify environment variables are set correctly
3. Restart backend server

### Symptom: Cache hits across instances

**Diagnosis:**
```bash
curl "http://localhost:3000/api/observability/stats?instanceId=instance_001"
# Shows: cache size = 5

curl "http://localhost:3000/api/observability/stats?instanceId=instance_002"
# Shows: cache size = 5  ← WRONG! Should be 0
```

**Fix:**
1. Check cache keys include instanceId: `instance_001::control_100`
2. Verify `cacheService.get()` filters by instanceId
3. Clear cache: restart backend

### Symptom: Traces are mixed

**Diagnosis:**
```bash
curl "http://localhost:3000/api/observability/traces?instanceId=instance_001" | grep instanceId
# Returns traces with instanceId=instance_002  ← WRONG!
```

**Fix:**
1. Verify `getTracesForInstance()` returns only matching instance
2. Check trace storage uses Map<instanceId, Trace[]>
3. Review middleware is setting req.instanceId correctly

### Symptom: Different instances see same logs

**Diagnosis:**
Logs contain mixed [ISOLATION] tags from different instances.

**Fix:**
1. Restart backend
2. Verify request middleware is capturing per-request logs
3. Check console.log hijacking is request-scoped

---

## Support

If isolation is broken:

1. **Stop the backend** immediately
2. **Check logs** for `[ISOLATION]` error tags
3. **Verify environment** variables:
   ```bash
   printenv | grep SERVICENOW
   ```
4. **Check request** includes instanceId
5. **Review middleware** is properly scoped
6. **Restart backend** - some state may be cached

Contact: [Your contact info]
