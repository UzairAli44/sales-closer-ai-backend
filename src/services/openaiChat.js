const OpenAI = require('openai');
const { evaluateLead, triggerCalendly } = require('../tools/leadTools');

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    const err = new Error('OPENAI_API_KEY is not set. Add it to a .env file in the backend folder (see .env.example).');
    err.code = 'OPENAI_API_KEY_MISSING';
    throw err;
  }
  return new OpenAI({ apiKey });
}

const SYSTEM_PROMPT = `You are a Sales Closer: Lead Qualification Agent. Your job is to qualify leads by gathering exactly these four pieces of information in a friendly, conversational way:

1. **Name** – The prospect's full name
2. **Company** – The company or organization they represent
3. **Budget** – Their budget range or willingness to invest (you can ask in a natural way)
4. **Timeline** – When they want to start or make a decision

Rules:
- Ask for one thing at a time when possible; keep the conversation natural.
- Once you have all four (name, company, budget, timeline), you MUST call the evaluateLead function with that data. Do not summarize or ask for more—call the function.
- If evaluateLead returns isHotLead: true, you MUST then call triggerCalendly to offer them a meeting. Respond by inviting them to book a time and mention that a calendar will appear.
- If isHotLead is false, thank them and say you'll have someone follow up, or suggest they fill out a form—do NOT call triggerCalendly.
- Be concise and professional.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'evaluateLead',
      description: 'Evaluate whether the lead is hot based on collected name, company, budget, and timeline. Call this only when all four fields are known.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Full name of the prospect' },
          company: { type: 'string', description: 'Company or organization name' },
          budget: { type: 'string', description: 'Budget range or investment level' },
          timeline: { type: 'string', description: 'When they want to start or decide' },
        },
        required: ['name', 'company', 'budget', 'timeline'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'triggerCalendly',
      description: 'Trigger the Calendly booking flow for the prospect. Call this only when evaluateLead has returned isHotLead: true.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

/**
 * Handles one round of chat: sends messages to OpenAI, runs tool calls (evaluateLead, triggerCalendly), and returns assistant message + any tool results for the client.
 */
async function handleChat(messages) {
  const openai = getOpenAIClient();
  const apiMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.map((m) => ({ role: m.role, content: m.content || '' })),
  ];

  let response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: apiMessages,
    tools: TOOLS,
    tool_choice: 'auto',
  });

  const assistantMessage = response.choices[0].message;
  const toolCalls = assistantMessage.tool_calls || [];
  const toolResults = [];

  if (toolCalls.length === 0) {
    return {
      message: { role: 'assistant', content: assistantMessage.content },
      toolResults: [],
    };
  }

  const newMessages = [
    ...apiMessages,
    {
      role: 'assistant',
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
    },
  ];

  for (const tc of toolCalls) {
    const name = tc.function.name;
    const args = JSON.parse(tc.function.arguments || '{}');
    let result;

    if (name === 'evaluateLead') {
      result = evaluateLead(args);
    } else if (name === 'triggerCalendly') {
      result = triggerCalendly();
    } else {
      result = { error: `Unknown tool: ${name}` };
    }

    toolResults.push({ toolCallId: tc.id, name, result });
    newMessages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify(result),
    });
  }

  // Let the model respond to tool results (e.g. say "Book a time below" after triggerCalendly)
  const followUp = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: newMessages,
    tools: TOOLS,
    tool_choice: 'auto',
  });

  const followUpMessage = followUp.choices[0].message;
  const followUpToolCalls = followUpMessage.tool_calls || [];

  if (followUpToolCalls.length > 0) {
    const innerMessages = [
      ...newMessages,
      {
        role: 'assistant',
        content: followUpMessage.content,
        tool_calls: followUpMessage.tool_calls,
      },
    ];
    for (const tc of followUpToolCalls) {
      const name = tc.function.name;
      const args = JSON.parse(tc.function.arguments || '{}');
      const result =
        name === 'evaluateLead' ? evaluateLead(args) : name === 'triggerCalendly' ? triggerCalendly() : { error: `Unknown tool: ${name}` };
      toolResults.push({ toolCallId: tc.id, name, result });
      innerMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
    const final = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: innerMessages,
      tools: TOOLS,
      tool_choice: 'auto',
    });
    const finalContent = final.choices[0].message.content;
    return {
      message: { role: 'assistant', content: finalContent },
      toolResults,
    };
  }

  return {
    message: { role: 'assistant', content: followUpMessage.content },
    toolResults,
  };
}

module.exports = { handleChat };
