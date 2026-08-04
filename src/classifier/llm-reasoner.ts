import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from '../config/index.js';
import { GmailMessageSummary, ClassificationResult } from '../types/index.js';

export class LLMReasoner {
  private anthropic: Anthropic | null = null;

  private getClient(): Anthropic | null {
    if (this.anthropic) return this.anthropic;
    if (CONFIG.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });
    }
    return this.anthropic;
  }

  /**
   * Analyze email content against task description to determine status and generate summary remarks
   */
  public async classifySubmission(
    taskDescription: string,
    dueDateStr: string,
    email: GmailMessageSummary,
    timeboxAnalysis: { isWithin: boolean; isEarly: boolean; reason: string }
  ): Promise<ClassificationResult> {
    const client = this.getClient();

    // Fallback deterministic classification if LLM API key not available
    if (!client) {
      return this.fallbackDeterministicClassify(taskDescription, email, timeboxAnalysis);
    }

    const prompt = `
You are the AI Auditor for the CFO Command Centre (OGI Finance Office).
Your job is to analyze an incoming email reply against a specific assigned task to determine if the task was completed.

TASK DETAILS:
- Task Description: "${taskDescription}"
- Expected Due Date: "${dueDateStr}"

INCOMING EMAIL:
- From: ${email.from}
- Subject: ${email.subject}
- Date Received: ${email.date.toISOString()}
- Has Attachments: ${email.hasAttachments ? 'YES' : 'NO'}
- Body Snippet:
"""
${email.bodyText.substring(0, 1500)}
"""

TIMEBOXING EVALUATION (DETERMINISTIC):
- Is within valid due-date window: ${timeboxAnalysis.isWithin}
- Is early: ${timeboxAnalysis.isEarly}
- Window Note: ${timeboxAnalysis.reason}

CLASSIFICATION RULES:
1. "Received": Valid report/submission attached or clearly stated completion within valid time window.
2. "Received (Early)": Valid report/submission received before the due date.
3. "Partial/Unclear": Reply exists, but user says e.g. "will send tomorrow", "working on it", or provides incomplete/unclear information without actual report/data attached.
4. "Irrelevant": Email is unrelated to this task.

Respond STRICTLY in JSON format with no additional text:
{
  "classification": "Received" | "Received (Early)" | "Partial/Unclear" | "Irrelevant",
  "summaryRemarks": "Concise 1-sentence summary of submission and date for Sheet Remarks column",
  "confidence": 0.0 to 1.0,
  "reasoning": "Explanation of decision"
}
`;

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-5',
        // Adaptive thinking is ON by default on Sonnet 5 and max_tokens caps
        // thinking + response text together — 300 would truncate the JSON and
        // silently drop us into the deterministic fallback.
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        // Classification is a short, scoped judgement call; low effort keeps
        // per-email cost down without giving up the reasoning step.
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: prompt }],
      });

      const textBlock = response.content.find(b => b.type === 'text');
      const text = textBlock ? textBlock.text : '';
      const parsed = JSON.parse(text);

      let finalStatus = parsed.classification;
      if (!timeboxAnalysis.isWithin && (finalStatus === 'Received' || finalStatus === 'Received (Early)')) {
        // If outside time window, keep remark but handle status accordingly
        parsed.summaryRemarks += ` (Outside window: ${timeboxAnalysis.reason})`;
      }

      return {
        status: finalStatus,
        remarks: `${parsed.summaryRemarks} [${email.date.toLocaleDateString()}]`,
        threadId: email.threadId,
        messageId: email.id,
        receivedDate: email.date,
        confidence: parsed.confidence || 0.9,
        reasoning: parsed.reasoning || '',
      };
    } catch (err: any) {
      console.warn('⚠️ Anthropic API call failed or unconfigured, falling back to deterministic reasoning:', err.message);
      return this.fallbackDeterministicClassify(taskDescription, email, timeboxAnalysis);
    }
  }

  private fallbackDeterministicClassify(
    taskDescription: string,
    email: GmailMessageSummary,
    timeboxAnalysis: { isWithin: boolean; isEarly: boolean; reason: string }
  ): ClassificationResult {
    const textLower = (email.subject + ' ' + email.bodyText).toLowerCase();
    const hasWorkInConcept = textLower.includes('will send') || textLower.includes('delay') || textLower.includes('working on');

    if (hasWorkInConcept && !email.hasAttachments) {
      return {
        status: 'Partial/Unclear',
        remarks: `Reply received: "${email.snippet.substring(0, 50)}..." — flagged for human review [${email.date.toLocaleDateString()}]`,
        threadId: email.threadId,
        messageId: email.id,
        receivedDate: email.date,
        confidence: 0.7,
        reasoning: 'Reply indicates in-progress or delayed status without final attachment.',
      };
    }

    const isEarly = timeboxAnalysis.isEarly;
    const status = isEarly ? 'Received (Early)' : 'Received';

    return {
      status,
      remarks: `Submitted via email "${email.subject}" with ${email.hasAttachments ? 'attachments' : 'confirmation'} [${email.date.toLocaleDateString()}]`,
      threadId: email.threadId,
      messageId: email.id,
      receivedDate: email.date,
      confidence: 0.8,
      reasoning: 'Matched reply received within window.',
    };
  }
}
