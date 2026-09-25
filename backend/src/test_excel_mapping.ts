import * as XLSX from 'xlsx';
import { processExcelMapping } from './services/excel_mapping_service';
import { GeminiLLMClient } from './llm/llm_client';
import fs from 'fs';
import path from 'path';

async function runTest() {
  console.log('[TEST] Constructing sample input Excel workbook in memory...');

  // Sample Risks Data
  const risksData = [
    {
      'Risk ID': 'RSK-001',
      'Title': 'Unauthorized Database Privilege Escalation',
      'Description': 'Risk of non-admin users escalating privileges to access sensitive customer database records and PII.',
      'Owning Entity': 'Core Database Infrastructure'
    },
    {
      'Risk ID': 'RSK-002',
      'Title': 'Unencrypted Data Transmission Over Public Networks',
      'Description': 'Risk of interception or eavesdropping when transmitting confidential financial payloads across unencrypted HTTP channels.',
      'Owning Entity': 'Payment Gateway API'
    }
  ];

  // Sample Controls Data
  const controlsData = [
    {
      'Control ID': 'CTL-101',
      'Title': 'Database Role-Based Access Control (RBAC) & Least Privilege',
      'Description': 'Enforce database role-based access control policies with explicit separation of duties and quarterly privilege audits.',
      'Category': 'Access Control'
    },
    {
      'Control ID': 'CTL-102',
      'Title': 'Mandatory TLS 1.3 Endpoint Encryption',
      'Description': 'Enforce TLS 1.3 SSL certificate encryption for all inbound and outbound API request payloads.',
      'Category': 'Network Security'
    },
    {
      'Control ID': 'CTL-103',
      'Title': 'Daily Database Backup Integrity Checks',
      'Description': 'Automated daily snapshot backups with automated checksum verification.',
      'Category': 'Data Recovery'
    }
  ];

  // Build Input Workbook
  const workbook = XLSX.utils.book_new();
  const riskSheet = XLSX.utils.json_to_sheet(risksData);
  const controlSheet = XLSX.utils.json_to_sheet(controlsData);
  XLSX.utils.book_append_sheet(workbook, riskSheet, 'Risks');
  XLSX.utils.book_append_sheet(workbook, controlSheet, 'Controls');

  const inputBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  console.log(`[TEST] Generated sample input Excel file (${inputBuffer.length} bytes).`);

  // Run Service
  const llmClient = new GeminiLLMClient();
  console.log('[TEST] Executing processExcelMapping...');
  const outputBuffer = await processExcelMapping(inputBuffer, llmClient);

  // Read back output to verify
  const resultWorkbook = XLSX.read(outputBuffer, { type: 'buffer' });
  console.log(`[TEST] Result workbook sheets: ${resultWorkbook.SheetNames.join(', ')}`);

  const mappedSheet = resultWorkbook.Sheets['Mapped_Risk_Control_Results'];
  const mappedRows: any[] = XLSX.utils.sheet_to_json(mappedSheet);

  console.log('\n================================================================================');
  console.log('  EXCEL MAPPING TEST RESULT PREVIEW');
  console.log('================================================================================');
  console.table(mappedRows.map(r => ({
    RiskID: r['Risk ID'],
    RiskName: r['Risk Name'],
    ControlID: r['Mapped Control ID'],
    ControlName: r['Mapped Control Name'],
    Status: r['Mapping Status']
  })));

  const testOutputPath = path.join(__dirname, '../sample_mapped_output.xlsx');
  fs.writeFileSync(testOutputPath, outputBuffer);
  console.log(`\n[TEST SUCCESS] Saved test output to: ${testOutputPath}`);
}

runTest().catch(err => {
  console.error('[TEST FAILED]', err);
  process.exit(1);
});
