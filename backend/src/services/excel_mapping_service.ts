import * as XLSX from 'xlsx';
import { ExcelAdapter } from '../adapters/excel_adapter';
import { RiskControlMappingAgent } from '../core/agents';
import { BaseLLMClient } from '../llm/llm_client';

export interface ExcelMappingProgress {
  totalRisks: number;
  processedRisks: number;
  mappedPairingsCount: number;
  unmitigatedGapsCount: number;
}

export async function processExcelMapping(
  fileBuffer: Buffer,
  llmClient: BaseLLMClient,
  onProgress?: (progress: ExcelMappingProgress) => void
): Promise<Buffer> {
  const adapter = new ExcelAdapter(fileBuffer);
  const agent = new RiskControlMappingAgent(adapter, llmClient);

  const risks = await adapter.getAllRisks();
  const allControls = await adapter.getControlsForEntity();

  console.log(`[ExcelMappingService] Starting mapping execution for ${risks.length} risk(s) against ${allControls.length} candidate control(s)...`);

  const outputRows: any[] = [];
  let mappedPairingsCount = 0;
  let unmitigatedGapsCount = 0;

  for (let i = 0; i < risks.length; i++) {
    const risk = risks[i];
    console.log(`[ExcelMappingService] Mapping risk [${i + 1}/${risks.length}]: ${risk.name} (${risk.sysId})`);

    try {
      const result: any = await agent.execute(risk.sysId);

      const selectedControls: any[] = result.selectedControls || [];
      const justification: string = result.justification || result.rationale || 'Evaluated by RiskControlMappingAgent';
      const recommendations: string = result.recommendations || result.gaps || 'None';

      if (selectedControls.length > 0) {
        for (const ctrl of selectedControls) {
          mappedPairingsCount++;
          outputRows.push({
            'Risk ID': risk.sysId,
            'Risk Name': risk.name,
            'Risk Description': risk.description || '',
            'Mapped Control ID': ctrl.sysId,
            'Mapped Control Name': ctrl.name,
            'Mapped Control Category': ctrl.category || 'General',
            'Mapped Control Description': ctrl.description || '',
            'Mapping Status': 'MAPPED',
            'Mapping Rationale': justification,
            'Gaps & AI Recommendations': recommendations
          });
        }
      } else {
        unmitigatedGapsCount++;
        outputRows.push({
          'Risk ID': risk.sysId,
          'Risk Name': risk.name,
          'Risk Description': risk.description || '',
          'Mapped Control ID': 'UNMAPPED_GAP',
          'Mapped Control Name': 'No Mitigating Control Found',
          'Mapped Control Category': 'N/A',
          'Mapped Control Description': 'No control in the uploaded sheet adequately mitigates this risk statement.',
          'Mapping Status': 'UNMITIGATED_GAP',
          'Mapping Rationale': justification,
          'Gaps & AI Recommendations': recommendations
        });
      }
    } catch (err: any) {
      console.error(`[ExcelMappingService] Failed to map risk ${risk.sysId}: ${err.message}`);
      outputRows.push({
        'Risk ID': risk.sysId,
        'Risk Name': risk.name,
        'Risk Description': risk.description || '',
        'Mapped Control ID': 'ERROR',
        'Mapped Control Name': 'Mapping Execution Error',
        'Mapped Control Category': 'N/A',
        'Mapped Control Description': err.message,
        'Mapping Status': 'ERROR',
        'Mapping Rationale': 'Agent execution encountered an error.',
        'Gaps & AI Recommendations': 'Retry or review risk text.'
      });
    }

    if (onProgress) {
      onProgress({
        totalRisks: risks.length,
        processedRisks: i + 1,
        mappedPairingsCount,
        unmitigatedGapsCount
      });
    }
  }

  // Create Output Workbook
  const worksheet = XLSX.utils.json_to_sheet(outputRows);

  // Set column widths for clean presentation
  worksheet['!cols'] = [
    { wch: 15 }, // Risk ID
    { wch: 30 }, // Risk Name
    { wch: 45 }, // Risk Description
    { wch: 18 }, // Mapped Control ID
    { wch: 30 }, // Mapped Control Name
    { wch: 22 }, // Mapped Control Category
    { wch: 45 }, // Mapped Control Description
    { wch: 18 }, // Mapping Status
    { wch: 55 }, // Mapping Rationale
    { wch: 55 }  // Gaps & AI Recommendations
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Mapped_Risk_Control_Results');

  // Summary Sheet
  const summaryRows = [
    { Metric: 'Total Input Risks', Value: risks.length },
    { Metric: 'Total Input Controls', Value: allControls.length },
    { Metric: 'Successful Mapped Pairings', Value: mappedPairingsCount },
    { Metric: 'Unmitigated Risk Gaps', Value: unmitigatedGapsCount },
    { Metric: 'Execution Engine', Value: 'RiskControlMappingAgent (SKILL-07)' },
    { Metric: 'Generated Timestamp', Value: new Date().toISOString() }
  ];
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  summarySheet['!cols'] = [{ wch: 30 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Mapping_Summary');

  const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  console.log(`[ExcelMappingService] Successfully generated mapped output workbook (${excelBuffer.length} bytes).`);
  return excelBuffer;
}
