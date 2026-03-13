/**
 * Evaluates lead quality based on name, company, budget, and timeline.
 * Returns isHotLead: true when criteria suggest high intent (e.g. budget and timeline present and reasonable).
 */
function evaluateLead({ name, company, budget, timeline }) {
  if (!name || !company || !budget || !timeline) {
    return {
      isHotLead: false,
      reason: 'Missing required fields for evaluation.',
    };
  }

  const budgetLower = (budget || '').toLowerCase();
  const timelineLower = (timeline || '').toLowerCase();

  const hasBudgetSignal =
    /\d|k|m|thousand|million|budget|invest|ready|approved/i.test(budgetLower) &&
    !/no budget|no money|not sure|undecided|tbd/i.test(budgetLower);

  const hasTimelineSignal =
    /\d|week|month|quarter|asap|soon|immediate|next|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q1|q2|q3|q4/i.test(timelineLower) &&
    !/no timeline|not sure|undecided|someday|maybe/i.test(timelineLower);

  const isHotLead = hasBudgetSignal && hasTimelineSignal;

  return {
    isHotLead,
    reason: isHotLead
      ? 'Budget and timeline indicate high intent.'
      : 'Budget or timeline not yet committed; follow up later.',
  };
}

/**
 * Triggers Calendly flow. Returns a payload the frontend can use to show the Calendly embed.
 */
function triggerCalendly() {
  const eventTypeUrl =
    process.env.CALENDLY_EVENT_TYPE_URL || 'https://calendly.com/demo/30min';
  return {
    showCalendly: true,
    calendlyUrl: eventTypeUrl,
    message: 'Please book a time below.',
  };
}

module.exports = { evaluateLead, triggerCalendly };
