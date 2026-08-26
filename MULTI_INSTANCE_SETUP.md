# Multi-Instance Setup Guide

## Overview

The system now supports **complete isolation** between multiple ServiceNow instances (clients). Each client's agents operate independently with:

- ✅ Separate credentials per instance
- ✅ No data leakage between instances
- ✅ Instance-specific caching
- ✅ Instance-scoped observability/logs
- ✅ Automatic scaling with new env vars (no code changes needed)

---

## Architecture Guarantee

**CRITICAL ISOLATION PROPERTY:**
> No data field, cache entry, log, trace, or state from one instance should ever be accessible by another instance.

- Each `ServiceNowAdapter` reads from **instance-specific ServiceNow URL**
- Each request is validated and routed to **correct instance only**
- All traces, cache, and logs are **namespaced by instanceId**
- Error messages are **sanitized** to not leak other instances' data
- Concurrent requests from different instances **never collide**

---

## Configuration

### Single Instance (Backward Compatible)

If you're using a **single ServiceNow instance**, use the legacy environment variables:

```env
SERVICENOW_INSTANCE_URL=https://client1.service-now.com
SERVICENOW_INSTANCE_KEY=your_api_key_here
GEMINI_API_KEY=your_gemini_key
PORT=3000
```

The system automatically defaults to `instanceId: "default"` and works as before.

### Multiple Instances (New)

To onboard **multiple ServiceNow clients**, configure them like this:

```env
# List of all instances
SERVICENOW_INSTANCES=instance_001,instance_002,instance_003

# Client 1 Configuration
SERVICENOW_INSTANCE_001_URL=https://client1.service-now.com
SERVICENOW_INSTANCE_001_KEY=client1_api_key_here

# Client 2 Configuration
SERVICENOW_INSTANCE_002_URL=https://client2.service-now.com
SERVICENOW_INSTANCE_002_KEY=client2_api_key_here

# Client 3 Configuration
SERVICENOW_INSTANCE_003_URL=https://client3.service-now.com
SERVICENOW_INSTANCE_003_KEY=client3_api_key_here

# Shared services
GEMINI_API_KEY=your_gemini_key
PORT=3000
```

---

## API Usage

### Sending Requests to Specific Instance

When calling any API endpoint, **specify the instance**:

#### Option 1: Request Body (Recommended)

```javascript
POST /api/run-agent
{
  "instanceId": "instance_001",
  "platform": "servicenow",
  "agent": "control-effectiveness",
  "targetId": "inst_301"
}
```

#### Option 2: Query Parameter

```
GET /api/platforms/servicenow/risks?instanceId=instance_001
```

#### Option 3: HTTP Header

```
GET /api/platforms/servicenow/assessments
X-Instance-Id: instance_001
```

---

## Frontend Integration

### Dashboard Selector

The frontend should include an instance selector (dropdown) before running agents:

```javascript
// In frontend/app.js
let selectedInstance = 'instance_001'; // Default

// Fetch available instances
async function loadAvailableInstances() {
  const response = await fetch('/api/platforms?instanceId=instance_001');
  const data = await response.json();
  console.log('Current instance:', data.instanceId);
  console.log('Is configured:', data.instance.isConfigured);
}

// When running an agent
async function runAgent(agent, targetId) {
  const response = await fetch('/api/run-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instanceId: selectedInstance,  // ✅ CRITICAL: Include instance
      platform: 'servicenow',
      agent: agent,
      targetId: targetId
    })
  });

  const result = await response.json();
  console.log('Result instanceId:', result.instanceId); // Verify isolation
  return result;
}
```

---

## Adding a New Client

### Step-by-Step

**1. Get ServiceNow Credentials from Client**
```
ServiceNow Instance URL: https://newclient.service-now.com
API Key: abc123xyz...
```

**2. Add to Environment Variables**

```env
SERVICENOW_INSTANCES=instance_001,instance_002,instance_new_client

# New Client Configuration
SERVICENOW_INSTANCE_NEW_CLIENT_URL=https://newclient.service-now.com
SERVICENOW_INSTANCE_NEW_CLIENT_KEY=abc123xyz...
```

**3. Restart Backend Server**
```bash
npm run dev  # or restart on Vercel
```

**4. Test the Connection**
```bash
curl -X GET "http://localhost:3000/api/platforms?instanceId=instance_new_client"
```

Expected response:
```json
{
  "instanceId": "instance_new_client",
  "instance": {
    "instanceId": "instance_new_client",
    "isConfigured": true,
    "hasUrl": true,
    "hasKey": true
  },
  "platforms": [...]
}
```

**5. Update Frontend with New Instance Selector**
```javascript
const INSTANCES = [
  { id: 'instance_001', label: 'Client 1' },
  { id: 'instance_002', label: 'Client 2' },
  { id: 'instance_new_client', label: 'New Client' }
];
```

---

## Isolation Verification

### 1. Check Instance Metadata

```bash
curl -X GET "http://localhost:3000/api/platforms?instanceId=instance_001"
```

Response should include only instance_001 data.

### 2. Verify Data Isolation

Run an agent for instance_001:
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

Response should include:
```json
{
  "success": true,
  "instanceId": "instance_001",
  "result": {...}
}
```

### 3. Check Logs are Instance-Scoped

```bash
curl -X GET "http://localhost:3000/api/observability/traces?instanceId=instance_001"
```

Should only return traces tagged with `instanceId: "instance_001"`.

### 4. Attempt Cross-Instance Access (Should Fail)

Try accessing instance_002's risks while scoped to instance_001:

```bash
curl -X GET "http://localhost:3000/api/platforms/servicenow/risks?instanceId=instance_002"
```

**Without** specifying a valid instance, it should return 403:
```json
{
  "success": false,
  "error": "Instance 'instance_002' not found or not configured.",
  "availableInstances": ["instance_001", "instance_002"]
}
```

---

## Concurrent Request Handling

The system safely handles concurrent requests from different instances:

```javascript
// Client 1 Request (at same time as Client 2)
fetch('/api/run-agent', {
  method: 'POST',
  body: JSON.stringify({
    instanceId: 'instance_001',
    agent: 'control-effectiveness',
    targetId: 'risk_001'
  })
});

// Client 2 Request (simultaneous)
fetch('/api/run-agent', {
  method: 'POST',
  body: JSON.stringify({
    instanceId: 'instance_002',
    agent: 'inherent-assessment',
    targetId: 'risk_002'
  })
});
```

**Result:**
- Request 1 reads/writes to Client 1's ServiceNow only
- Request 2 reads/writes to Client 2's ServiceNow only
- Caches are separate (no collision)
- Traces/logs are separate
- **Zero interference guaranteed**

---

## Deployment (Vercel)

### Vercel Environment Variables

Go to [Project Settings > Environment Variables](https://vercel.com/srujanwissdas-projects/grc-agent-hub/settings/environment-variables)

Add:
```
SERVICENOW_INSTANCES = instance_001,instance_002
SERVICENOW_INSTANCE_001_URL = https://client1.service-now.com
SERVICENOW_INSTANCE_001_KEY = ...
SERVICENOW_INSTANCE_002_URL = https://client2.service-now.com
SERVICENOW_INSTANCE_002_KEY = ...
GEMINI_API_KEY = ...
```

Then **redeploy** to apply changes:
```bash
git push  # Triggers Vercel build
```

---

## Troubleshooting

### Issue: "Instance 'instance_001' not found"

**Cause:** Instance is not configured in environment variables.

**Fix:** Verify env vars are set:
```bash
echo $SERVICENOW_INSTANCES
echo $SERVICENOW_INSTANCE_001_URL
echo $SERVICENOW_INSTANCE_001_KEY
```

### Issue: Agent reads wrong instance's data

**Cause:** Frontend not sending instanceId in request.

**Fix:** Ensure request includes instanceId:
```javascript
// ✅ CORRECT
{
  "instanceId": "instance_001",
  "platform": "servicenow",
  "agent": "control-effectiveness",
  "targetId": "inst_301"
}

// ❌ WRONG (missing instanceId)
{
  "platform": "servicenow",
  "agent": "control-effectiveness",
  "targetId": "inst_301"
}
```

### Issue: Traces/logs are mixed

**Cause:** Observability service not properly scoped.

**Check:**
```bash
curl "http://localhost:3000/api/observability/traces?instanceId=instance_001"
```

Should ONLY show traces from instance_001. If mixing, restart backend.

### Issue: Cache collision

**Cause:** Cache not instance-specific.

**Check:**
```bash
curl "http://localhost:3000/api/observability/stats?instanceId=instance_001"
```

Cache should be empty initially, then populate only with this instance's data.

---

## Environment Variable Reference

| Variable | Type | Required | Example |
|----------|------|----------|---------|
| `SERVICENOW_INSTANCES` | String (comma-separated) | No | `instance_001,instance_002` |
| `SERVICENOW_INSTANCE_<ID>_URL` | String | Yes (per instance) | `https://client1.service-now.com` |
| `SERVICENOW_INSTANCE_<ID>_KEY` | String | Yes (per instance) | `abc123xyz...` |
| `GEMINI_API_KEY` | String | Yes | `AIzaS...` |
| `PORT` | Number | No | `3000` |
| `CRON_SECRET` | String | No (for cron jobs) | `secret-key` |

---

## Best Practices

1. **Always include instanceId** in requests (no accidental defaults)
2. **Monitor logs** for `[ISOLATION]` tags to catch cross-instance issues
3. **Test with concurrent requests** from different instances
4. **Keep instance IDs short** (e.g., `client_001` not `my_very_important_client_instance`)
5. **Document which client maps to which instanceId** in your runbooks
6. **Rotate API keys** regularly per instance
7. **Set CRON_SECRET** for cron-triggered integrity scans

---

## Support

If you encounter issues:

1. Check logs for `[ISOLATION]` error tags
2. Verify environment variables are set correctly
3. Restart backend after env var changes
4. Check that instanceId is valid (in SERVICENOW_INSTANCES list)
5. Verify ServiceNow API credentials are correct for the instance

