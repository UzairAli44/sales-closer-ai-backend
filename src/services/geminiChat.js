const { GoogleGenAI } = require('@google/genai');
const { evaluateLead, triggerCalendly } = require('../tools/leadTools');

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    const err = new Error(
      'GEMINI_API_KEY is not set. Add it to a .env file in the backend folder (see .env.example).'
    );
    err.code = 'GEMINI_API_KEY_MISSING';
    throw err;
  }
  return new GoogleGenAI({ apiKey });
}

const SYSTEM_PROMPT = `You are a lead qualification bot. You collect exactly 4 fields, one at a time, then call evaluateLead.

FIELDS TO COLLECT (in this order):
1. Name (the first message already asked for this, so if the user's first reply looks like a name, accept it and move to field 2)
2. Company name
3. Budget range
4. Timeline (when they want to start)

RULES YOU MUST FOLLOW:
- Ask for ONLY ONE field per message.
- Keep each response to 1 sentence. Do NOT write long messages.
- When the user answers a field, accept it immediately. Do NOT ask follow-up questions, clarifications, or ask what the company does. Just say thanks briefly and ask for the next field.
- Do NOT discuss their business, products, services, role, industry, or anything unrelated to the 4 fields.
- If the user says "hi", "hey", "hello" or similar without giving a name, just ask for their name.
- As soon as you have all 4 fields, call evaluateLead immediately. Do NOT summarize or confirm the data first.
- If evaluateLead returns isHotLead: true, call triggerCalendly immediately, then say "Great news! A calendar has appeared below — please book a time that works for you."
- If evaluateLead returns isHotLead: false, say "Thanks! Someone from our team will follow up with you soon." Do NOT call triggerCalendly.

EXAMPLE CONVERSATION:
User: Uzair
You: Thanks, Uzair! What company are you with?
User: Acme Corp
You: Got it! What's your budget range for this project?
User: Around $10k
You: And when are you looking to get started?
User: Next month
You: [calls evaluateLead]`;

const TOOLS = {
  functionDeclarations: [
    {
      name: 'evaluateLead',
      description:
        'Evaluate whether the lead is hot based on collected name, company, budget, and timeline. Call this only when all four fields are known.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'Full name of the prospect' },
          company: { type: 'STRING', description: 'Company or organization name' },
          budget: { type: 'STRING', description: 'Budget range or investment level' },
          timeline: { type: 'STRING', description: 'When they want to start or decide' },
        },
        required: ['name', 'company', 'budget', 'timeline'],
      },
    },
    {
      name: 'triggerCalendly',
      description:
        'Trigger the Calendly booking flow for the prospect. Call this only when evaluateLead has returned isHotLead: true.',
      parameters: {
        type: 'OBJECT',
        properties: {},
      },
    },
  ],
};

function runTool(name, args) {
  if (name === 'evaluateLead') return evaluateLead(args || {});
  if (name === 'triggerCalendly') return triggerCalendly();
  return { error: `Unknown tool: ${name}` };
}

/**
 * Convert frontend messages [{ role, content }] to Gemini contents format.
 * Gemini uses "user" and "model" (not "assistant").
 */
function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content || '' }],
  }));
}

/**
 * Append assistant message and tool response(s) to contents for the next request.
 */
function appendToolResults(contents, assistantText, functionCalls, toolResults) {
  const parts = [{ text: assistantText || '' }];
  for (let i = 0; i < functionCalls.length; i++) {
    const fc = functionCalls[i];
    parts.push({
      functionCall: {
        name: fc.name,
        args: fc.args || {},
      },
    });
  }
  contents.push({ role: 'model', parts });

  const functionResponseParts = functionCalls.map((fc, i) => ({
    functionResponse: {
      name: fc.name,
      response: toolResults[i],
    },
  }));
  contents.push({
    role: 'user',
    parts: functionResponseParts,
  });
}

/**
 * Handles one round of chat: sends messages to Gemini, runs tool calls, and returns assistant message + tool results.
 */
async function handleChat(messages) {
  const ai = getGeminiClient();
  const modelId = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  let contents = toGeminiContents(messages);

  const response = await ai.models.generateContent({
    model: modelId,
    contents,
    systemInstruction: SYSTEM_PROMPT,
    tools: TOOLS,
  });

  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts?.length) {
    return {
      message: { role: 'assistant', content: response.text || 'No response.' },
      toolResults: [],
    };
  }

  const parts = candidate.content.parts;
  const textPart = parts.find((p) => p.text != null);
  const assistantText = textPart?.text ?? '';
  const functionCalls = parts.filter((p) => p.functionCall != null).map((p) => p.functionCall);

  const toolResults = [];
  if (functionCalls.length === 0) {
    return {
      message: { role: 'assistant', content: assistantText },
      toolResults: [],
    };
  }

  for (const fc of functionCalls) {
    const result = runTool(fc.name, fc.args);
    toolResults.push({ toolCallId: fc.name, name: fc.name, result });
  }

  appendToolResults(contents, assistantText, functionCalls, toolResults.map((tr) => tr.result));

  const followUp = await ai.models.generateContent({
    model: modelId,
    contents,
    systemInstruction: SYSTEM_PROMPT,
    tools: TOOLS,
  });

  const followCandidate = followUp.candidates?.[0];
  const followParts = followCandidate?.content?.parts ?? [];
  const followTextPart = followParts.find((p) => p.text != null);
  let finalText = followTextPart?.text ?? followUp.text ?? '';
  const followFunctionCalls = followParts.filter((p) => p.functionCall != null).map((p) => p.functionCall);

  if (followFunctionCalls.length > 0) {
    for (const fc of followFunctionCalls) {
      const result = runTool(fc.name, fc.args);
      toolResults.push({ toolCallId: fc.name, name: fc.name, result });
    }
    const innerContents = [...contents];
    const followModelParts = [{ text: finalText }];
    followFunctionCalls.forEach((fc) => {
      followModelParts.push({ functionCall: { name: fc.name, args: fc.args || {} } });
    });
    innerContents.push({ role: 'model', parts: followModelParts });
    const lastToolResults = toolResults.slice(-followFunctionCalls.length).map((tr) => tr.result);
    innerContents.push({
      role: 'user',
      parts: followFunctionCalls.map((fc, i) => ({
        functionResponse: { name: fc.name, response: lastToolResults[i] },
      })),
    });
    const finalResponse = await ai.models.generateContent({
      model: modelId,
      contents: innerContents,
      systemInstruction: SYSTEM_PROMPT,
    });
    const finalCandidate = finalResponse.candidates?.[0];
    const finalTextPart = finalCandidate?.content?.parts?.find((p) => p.text != null);
    finalText = finalTextPart?.text ?? finalResponse.text ?? finalText;
  }

  return {
    message: { role: 'assistant', content: finalText },
    toolResults,
  };
}

module.exports = { handleChat };
