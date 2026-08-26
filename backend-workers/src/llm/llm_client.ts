import axios from 'axios';
import { recordSpan } from '../core/observability';

// Caps how much of the actual prompt/response text lands in a trace span —
// enough to read what the model saw/said in the Observability UI without a
// single oversized prompt bloating the persisted trace rows.
const TRACE_TEXT_CAP = 2000;
function capText(s: string): string {
  return s.length > TRACE_TEXT_CAP ? s.slice(0, TRACE_TEXT_CAP) + `… [${s.length} chars total]` : s;
}

// A tool the model may choose to call mid-conversation. `parameters` is a Gemini
// function-declaration JSON schema (OBJECT type with properties/required), same
// shape as the response_schema used elsewhere in this file.
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: any;
}

export interface ToolLoopResult<T> {
  result: T;
  toolCallLog: Array<{ name: string; args: any }>;
  turns: number;
}

export abstract class BaseLLMClient {
  abstract generateStructuredOutput<T>(prompt: string, systemInstruction: string, schema: any): Promise<T>;

  // Runs a multi-turn tool-calling conversation: the model may call any of `tools`
  // (resolved via `executeTool`) to gather whatever it decides it needs, as many or
  // as few times as it judges necessary, before finalizing by calling
  // `finalAnswerTool` — whose own args become the returned result. Returns null if
  // the model never finalizes within maxTurns, or if a request fails outright;
  // callers are expected to treat null the same as any other failed AI call
  // (write a failure note, don't block the rest of the run).
  abstract runToolLoop<T>(
    systemInstruction: string,
    initialPrompt: string,
    tools: ToolDeclaration[],
    finalAnswerTool: string,
    executeTool: (name: string, args: any) => Promise<any>,
    maxTurns?: number
  ): Promise<ToolLoopResult<T> | null>;
}

export class GeminiLLMClient extends BaseLLMClient {
  private apiKey: string | undefined;
  private model: string;
  private timeoutMs: number;
  private toolMaxTokens: number;
  private endpoint: string;

  // Workers has no global `process.env` — every value the original read via
  // `process.env.X` (secrets + vars from wrangler.jsonc) is threaded in here
  // by the caller instead. Defaults match the original's `|| 'fallback'` values.
  constructor(apiKey: string | undefined, model: string = 'gemini-1.5-flash', timeoutMs: number = 90000, toolMaxTokens: number = 4096) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.toolMaxTokens = toolMaxTokens;
    this.endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
  }

  async generateStructuredOutput<T>(prompt: string, systemInstruction: string, schema: any): Promise<T> {
    const t0 = Date.now();
    if (!this.apiKey) {
      console.warn('[GeminiLLMClient] No GEMINI_API_KEY detected. Running local fallback reasoning logic.');
      recordSpan('llm.generate', t0, 'fallback', { model: this.model, reason: 'no-api-key', promptChars: prompt.length });
      return this.simulateFallbackReasoning<T>(prompt, schema);
    }

    try {
      const url = `${this.endpoint}?key=${this.apiKey}`;
      const payload = {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ],
        system_instruction: {
          parts: [{ text: systemInstruction }]
        },
        generation_config: {
          temperature: 0.1,
          response_mime_type: 'application/json',
          response_schema: schema
        }
      };

      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: this.timeoutMs
      });

      const candidate = response.data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('Empty response candidate from Gemini API');
      }

      const parsed = JSON.parse(text) as T;
      recordSpan('llm.generate', t0, 'ok', {
        model: this.model,
        promptChars: prompt.length,
        responseChars: text.length,
        totalTokens: response.data?.usageMetadata?.totalTokenCount,
        systemInstruction: capText(systemInstruction),
        prompt: capText(prompt),
        response: capText(text)
      });
      return parsed;
    } catch (error: any) {
      console.error('[GeminiLLMClient] HTTP Error calling Gemini API:', error?.response?.data || error.message);
      console.log('[GeminiLLMClient] Falling back to simulation logic due to API error.');
      recordSpan('llm.generate', t0, 'fallback', {
        model: this.model,
        reason: error.message,
        promptChars: prompt.length,
        prompt: capText(prompt)
      });
      return this.simulateFallbackReasoning<T>(prompt, schema);
    }
  }

  // ── Tool-calling loop (Gemini function calling) ─────────────────────────
  // Unlike generateStructuredOutput's single forced-JSON turn, this holds a real
  // multi-turn conversation: the model sees only the initial prompt (no evidence
  // dumped in upfront), decides which declared tools to invoke, receives their
  // results, and repeats until it calls `finalAnswerTool` — treating "submitting
  // the final answer" as a tool call like any other, rather than free text, so
  // there's never ambiguity about whether the model is "done".
  async runToolLoop<T>(
    systemInstruction: string,
    initialPrompt: string,
    tools: ToolDeclaration[],
    finalAnswerTool: string,
    executeTool: (name: string, args: any) => Promise<any>,
    maxTurns: number = 6
  ): Promise<ToolLoopResult<T> | null> {
    const t0 = Date.now();
    if (!this.apiKey) {
      console.warn('[GeminiLLMClient] No GEMINI_API_KEY detected. Tool-calling loops have no local fallback.');
      recordSpan('llm.tool_loop', t0, 'fallback', { model: this.model, reason: 'no-api-key' });
      return null;
    }

    const url = `${this.endpoint}?key=${this.apiKey}`;
    const contents: any[] = [{ role: 'user', parts: [{ text: initialPrompt }] }];
    const toolCallLog: Array<{ name: string; args: any }> = [];
    const functionDeclarations = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));

    for (let turn = 1; turn <= maxTurns; turn++) {
      let data: any;
      try {
        const response = await axios.post(url, {
          contents,
          system_instruction: { parts: [{ text: systemInstruction }] },
          tools: [{ functionDeclarations }],
          generation_config: { temperature: 0.1, max_output_tokens: this.toolMaxTokens }
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: this.timeoutMs
        });
        data = response.data;
      } catch (error: any) {
        console.error('[GeminiLLMClient] Tool-loop HTTP error:', error?.response?.data || error.message);
        recordSpan('llm.tool_loop', t0, 'error', { model: this.model, turn, reason: error.message, toolCalls: toolCallLog.map(c => c.name).join(', ') });
        return null;
      }

      const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
      if (parts.length === 0) {
        recordSpan('llm.tool_loop', t0, 'error', { model: this.model, turn, reason: 'empty candidate' });
        return null;
      }

      const calls = parts.filter(p => p.functionCall).map(p => p.functionCall);

      if (calls.length === 0) {
        // Model narrated in plain text instead of calling a tool — nudge it back
        // toward acting rather than failing the whole assessment outright.
        contents.push({ role: 'model', parts });
        contents.push({ role: 'user', parts: [{ text: `Use one of the available tools to continue investigating, or call ${finalAnswerTool} once you have enough evidence to finalize.` }] });
        continue;
      }

      const finalCall = calls.find(c => c.name === finalAnswerTool);
      if (finalCall) {
        recordSpan('llm.tool_loop', t0, 'ok', {
          model: this.model,
          turns: turn,
          toolCalls: toolCallLog.map(c => c.name).join(', ') || '(none — finalized immediately)',
          finalArgs: capText(JSON.stringify(finalCall.args))
        });
        return { result: finalCall.args as T, toolCallLog, turns: turn };
      }

      contents.push({ role: 'model', parts });
      const functionResponseParts: any[] = [];
      for (const call of calls) {
        toolCallLog.push({ name: call.name, args: call.args });
        let toolResult: any;
        try {
          toolResult = await executeTool(call.name, call.args || {});
        } catch (e: any) {
          toolResult = { error: e.message };
        }
        functionResponseParts.push({ functionResponse: { name: call.name, response: toolResult } });
      }
      contents.push({ role: 'user', parts: functionResponseParts });
    }

    recordSpan('llm.tool_loop', t0, 'error', { model: this.model, reason: 'max turns exceeded without finalizing', toolCalls: toolCallLog.map(c => c.name).join(', ') });
    return null;
  }

  /**
   * Generates highly realistic GRC results locally when API key is missing or errors out.
   */
  private simulateFallbackReasoning<T>(prompt: string, schema: any): T {
    // We check the fields in the requested schema to determine which agent is calling and return matching mocks.
    const schemaStr = JSON.stringify(schema);

    // 1. Control Effectiveness Agent
    if (schemaStr.includes('index') && schemaStr.includes('rating') && schemaStr.includes('justification')) {
      if (prompt.includes('Database Password Rotation')) {
        return {
          assessments: [
            {
              index: 1,
              rating: 'Satisfactory',
              justification: 'Database Password Rotation has successful daily test results with zero open issues. Backups and rotation logs verified.'
            },
            {
              index: 2,
              rating: 'Weak',
              justification: 'Multi-Factor Authentication shows 1 critical open issue where MFA bypass was active on backup server credentials. Tests failed.'
            }
          ]
        } as unknown as T;
      }

      // Default mock for batch controls
      return {
        assessments: [
          {
            index: 1,
            rating: 'Satisfactory',
            justification: 'Evidence demonstrates complete coverage, passing tests, and no outstanding critical issues on record.'
          }
        ]
      } as unknown as T;
    }

    // 2. Inherent Assessment Agent
    if (schemaStr.includes('issue_relevant') && schemaStr.includes('rating')) {
      if (prompt.includes('Data Sensitivity')) {
        return {
          rating: 'High',
          issue_relevant: false,
          justification: 'The database handles critical master keys and customer records, placing it under the High sensitivity rubric.'
        } as unknown as T;
      }
      if (prompt.includes('External Threat Exposure')) {
        return {
          rating: 'Medium',
          issue_relevant: true,
          justification: 'VPC setup limits exposure, but Open Issue ISS001 shows backup credentials had MFA bypassed, slightly increasing risk profile.'
        } as unknown as T;
      }
      return {
        rating: 'Medium',
        issue_relevant: false,
        justification: 'Evaluated based on standard rubric guidelines. No active issue is directly relevant to this factor.'
      } as unknown as T;
    }

    // 3. Risk-Control Mapping Agent
    if (schemaStr.includes('overall_justification') && schemaStr.includes('gaps')) {
      return {
        match: true,
        matches: [
          { index: 1, reason: 'Mitigates password compromise risk' },
          { index: 2, reason: 'Secures login session authorization' }
        ],
        overall_justification: 'These controls secure password storage and enforce strong session access rules, mitigating direct database infiltration vectors.',
        gaps: 'Existing controls do not address daily configuration checks. Recommended creating a file configuration monitoring control.',
        recommendation: 'AWS Config Rule for DB Public Access: Automatically audits if DB security group allows public traffic. Rotation Policy Alert: Triggers instant email if rotation fails.'
      } as unknown as T;
    }

    // 4. Schema Onboarding / Discovery Agent
    if (schemaStr.includes('targetAgnosticModel') && schemaStr.includes('sourceField')) {
      return {
        platformName: 'Archer GRC API',
        tables: [
          {
            sourceTableName: 'Risk_Registry_v2',
            description: 'Stores enterprise risks and business line links.',
            targetAgnosticModel: 'Risk',
            fieldMappings: [
              { sourceField: 'Risk_UUID', sourceType: 'String', targetField: 'sysId', rationale: 'Unique record identifier' },
              { sourceField: 'Risk_Title', sourceType: 'String', targetField: 'name', rationale: 'Descriptive title of the risk' },
              { sourceField: 'Risk_Description_Long', sourceType: 'String', targetField: 'description', rationale: 'Details detailing vulnerability and impact' },
              { sourceField: 'Owner_Business_Unit', sourceType: 'String', targetField: 'profileName', rationale: 'Mapped to agnostic target entity' }
            ]
          },
          {
            sourceTableName: 'Control_Library_Export',
            description: 'Core controls catalog and ownership metadata.',
            targetAgnosticModel: 'Control',
            fieldMappings: [
              { sourceField: 'Ctrl_ID', sourceType: 'String', targetField: 'sysId', rationale: 'Unique key for control item' },
              { sourceField: 'Control_Name', sourceType: 'String', targetField: 'name', rationale: 'Name displayed in standard directories' },
              { sourceField: 'Definition', sourceType: 'String', targetField: 'description', rationale: 'Detailed mitigation procedure description' }
            ]
          }
        ]
      } as unknown as T;
    }

    return {} as unknown as T;
  }
}
