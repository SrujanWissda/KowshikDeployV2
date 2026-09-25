import * as XLSX from 'xlsx';
import { BaseGRCAdapter } from './base';
import { Risk, Control, TestEvidence, AssessmentInstance, Factor, FactorResponse } from '../core/models';

export class ExcelAdapter extends BaseGRCAdapter {
  private risks: Risk[] = [];
  private controls: Control[] = [];

  constructor(fileBuffer: Buffer) {
    super();
    this.parseExcel(fileBuffer);
  }

  private normalizeHeader(header: string): string {
    return header.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private getValue(row: Record<string, any>, possibleKeys: string[]): string | undefined {
    const normalizedRowKeys = Object.keys(row).reduce((acc, key) => {
      acc[this.normalizeHeader(key)] = row[key];
      return acc;
    }, {} as Record<string, any>);

    for (const key of possibleKeys) {
      const normKey = this.normalizeHeader(key);
      if (normalizedRowKeys[normKey] !== undefined && normalizedRowKeys[normKey] !== null) {
        return String(normalizedRowKeys[normKey]).trim();
      }
    }
    return undefined;
  }

  private parseExcel(buffer: Buffer): void {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetNames = workbook.SheetNames;

    let riskSheet = sheetNames.find(s => /risk/i.test(s));
    let controlSheet = sheetNames.find(s => /control/i.test(s));

    // Fallback to first/second sheet if specific names not found
    if (!riskSheet && sheetNames.length > 0) riskSheet = sheetNames[0];
    if (!controlSheet && sheetNames.length > 1) controlSheet = sheetNames[1];

    if (riskSheet) {
      const rawRisks: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[riskSheet]);
      this.risks = rawRisks.map((row, idx) => {
        const sysId = this.getValue(row, ['Risk ID', 'sysId', 'ID', 'Risk_ID', 'RiskId', 'Code']) || `RSK-${idx + 1}`;
        const name = this.getValue(row, ['Risk Name', 'Title', 'Name', 'Risk_Name', 'Risk', 'Risk Statement']) || `Risk ${idx + 1}`;
        const description = this.getValue(row, ['Description', 'Desc', 'Risk Description', 'Details']) || name;
        const profileName = this.getValue(row, ['Business Unit', 'Entity', 'Profile', 'Owning Entity']) || 'Unknown Entity';

        return {
          sysId,
          name,
          description,
          profileName
        };
      });
    }

    if (controlSheet && controlSheet !== riskSheet) {
      const rawControls: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[controlSheet]);
      this.controls = rawControls.map((row, idx) => {
        const sysId = this.getValue(row, ['Control ID', 'sysId', 'ID', 'Control_ID', 'ControlId', 'Code']) || `CTL-${idx + 1}`;
        const name = this.getValue(row, ['Control Name', 'Title', 'Name', 'Control_Name', 'Control']) || `Control ${idx + 1}`;
        const description = this.getValue(row, ['Description', 'Desc', 'Control Description', 'Activity', 'Details']) || name;
        const category = this.getValue(row, ['Category', 'Control Category', 'Type']) || 'General';

        return {
          sysId,
          name,
          description,
          category,
          active: true
        };
      });
    } else if (riskSheet) {
      // If single sheet contains controls columns as well
      const rawAll: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[riskSheet]);
      const extractedControls: Control[] = [];

      rawAll.forEach((row, idx) => {
        const cSysId = this.getValue(row, ['Control ID', 'Control_ID', 'ControlId']);
        const cName = this.getValue(row, ['Control Name', 'Control_Name', 'Control']);
        if (cSysId || cName) {
          extractedControls.push({
            sysId: cSysId || `CTL-${idx + 1}`,
            name: cName || `Control ${idx + 1}`,
            description: this.getValue(row, ['Control Description', 'Control Activity']) || cName || '',
            category: this.getValue(row, ['Category']) || 'General',
            active: true
          });
        }
      });

      if (extractedControls.length > 0) {
        this.controls = extractedControls;
      }
    }

    console.log(`[ExcelAdapter] Parsed ${this.risks.length} risk(s) and ${this.controls.length} control(s) from Excel input.`);
  }

  getEntityLabel(): string {
    return 'Excel Upload Workspace';
  }

  getPlatformName(): string {
    return 'Excel_Import';
  }

  async getAllRisks(): Promise<Risk[]> {
    return this.risks;
  }

  async getRisk(riskSysId: string): Promise<Risk | null> {
    return this.risks.find(r => r.sysId === riskSysId) || null;
  }

  async getControlsForEntity(profileSysId?: string): Promise<Control[]> {
    return this.controls;
  }

  async getControlEvidence(controlSysId: string): Promise<TestEvidence> {
    return {
      sysId: `EVID-${controlSysId}`,
      number: `TST-${controlSysId}`,
      name: `Test Evidence for ${controlSysId}`,
      state: 'Complete',
      effectiveness: 'Effective',
      status: 'Passed',
      closedIssues: 0,
      openIssues: []
    };
  }

  async getEntityIssues(profileSysId: string, riskSysId?: string): Promise<Array<{ desc: string; state: string; number?: string; priority?: string; isDirectLink?: boolean }>> {
    return [];
  }

  async getAssessmentInstance(instanceSysId: string): Promise<AssessmentInstance | null> {
    return null;
  }

  async getControlFactorRows(instanceSysId: string): Promise<FactorResponse[]> {
    return [];
  }

  async getAnswerableManualRows(instanceSysId: string): Promise<Factor[]> {
    return [];
  }

  async getFactorChoices(factorSysId: string): Promise<Factor | null> {
    return null;
  }

  async getPriorClosedAssessment(riskSysId: string, currentInstanceSysId: string): Promise<{ sysId: string; number: string } | null> {
    return null;
  }

  async getPriorControlAnswer(): Promise<any> {
    return null;
  }

  async writeControlEffectiveness(): Promise<boolean> {
    return true;
  }

  async writeRiskControlMapping(
    riskSysId: string,
    matchedControls: Array<{ sysId: string; reason: string }>,
    justification: string,
    gaps: string,
    recommendations: string
  ): Promise<boolean> {
    return true;
  }

  async writeInherentFactor(): Promise<boolean> {
    return true;
  }

  async writeFailure(rowSysId: string, reason: string): Promise<void> {
    console.warn(`[ExcelAdapter] Write failure for ${rowSysId}: ${reason}`);
  }
}
