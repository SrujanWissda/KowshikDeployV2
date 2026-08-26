# Implementation Plan: Live ServiceNow GRC Integration

This plan outlines the steps required to transition the ServiceNow Adapter from simulated mock arrays to live REST API calls against a ServiceNow Personal Developer Instance (PDI).

## User Review Required

> [!IMPORTANT]
> To connect to a live ServiceNow PDI, the system requires basic authentication credentials and instance configurations. You will need to add these variables to your backend `.env` file:
> - `SERVICENOW_INSTANCE_URL` (e.g., `https://dev12345.service-now.com`)
> - `SERVICENOW_USERNAME` (e.g., `admin`)
> - `SERVICENOW_PASSWORD`
> - `SERVICENOW_USE_LIVE` (Set to `true` to enable live fetching; defaults to `false` for fallback simulation)

---

## Open Questions

> [!WARNING]
> 1. **Table Namespace**: Standard GRC risk records in ServiceNow belong to the GRC application tables (like `sn_risk_risk`, `sn_compliance_control`, `sn_audit_control_test`, `sn_grc_issue`). PDIs require the **GRC: Risk Management** or **GRC: Advanced Risk** plugins to be active. If your PDI does not have these GRC plugins installed, we can fall back to custom or standard IT tables (e.g., `risk_conditions` or generic incident/change tables). Please let us know if standard GRC tables are configured on your PDI.
> 2. **SSL/TLS Certificates**: PDIs might sometimes use self-signed certificates or proxy layers. We will configure `axios` to run with standard security, but can add a flag to ignore TLS errors if needed.

---

## Proposed Changes

We will modify the following components in the `e:/ai agent` workspace:

### 1. Backend Configuration

#### [MODIFY] [servicenow.ts](file:///e:/ai%20agent/backend/src/adapters/servicenow.ts)
- Modify the `ServiceNowAdapter` class constructor to read:
  - `SERVICENOW_INSTANCE_URL`
  - `SERVICENOW_USERNAME`
  - `SERVICENOW_PASSWORD`
  - `SERVICENOW_USE_LIVE`
- Create a reusable HTTP request helper using `axios` that targets the ServiceNow Table API (`/api/now/table/{tableName}`).
- Update all adapter read methods (`getRisk`, `getControlsForEntity`, `getAssessmentInstance`, `getControlEvidence`) to fetch data dynamically from ServiceNow using HTTP Basic Auth when `SERVICENOW_USE_LIVE` is enabled.
- Handle fallback smoothly: if the connection fails or credentials are not configured, it should log a warning and return the mock simulation records.

#### [MODIFY] [app.ts](file:///e:/ai%20agent/backend/src/app.ts)
- Expose a new route `GET /api/platforms/servicenow/risks` to fetch and list all available risk records from the live ServiceNow instance (table `sn_risk_risk`).
- Update `GET /api/platforms` to return live-fetched targets if ServiceNow is connected in Live Mode.

### 2. Frontend Interface

#### [MODIFY] [app.js](file:///e:/ai%20agent/frontend/app.js)
- Enhance the `updateTargets` method to perform an asynchronous fetch to `GET /api/platforms/servicenow/risks` when "ServiceNow" is selected as the platform and the server is connected.
- Update the dropdown to display live fetched risks alongside their descriptions.

---

## Verification Plan

### Manual Verification
1. Configure credentials in `e:/ai agent/backend/.env` with your ServiceNow PDI details.
2. Start the Express server with `npm run dev`.
3. Open [index.html](file:///e:/ai%20agent/frontend/index.html).
4. Verify that the platform selector displays live risks fetched from your ServiceNow instance.
5. Execute the **Risk-Control Mapping Agent** or **Control Effectiveness Agent** and inspect the step-by-step logs to confirm the REST API GET/POST payloads sent to ServiceNow.
