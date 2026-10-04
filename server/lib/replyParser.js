// Decides whether an email reply means "approve", "reject", or something we
// can't safely interpret. This gates safety-permit approvals, so it is
// deliberately conservative: anything hedged, conditional, or a question comes
// back as 'unclear' and the approver is asked to use the link instead. A wrong
// "approve" is the costly mistake; an "unclear" only costs one extra click.

const QUOTE_MARKERS = [
  /^>/,                                   // quoted lines
  /^on .{5,200}wrote:?\s*$/i,             // "On Mon, 5 Oct ... wrote:"
  /^-{2,}\s*original message\s*-{2,}/i,   // Outlook
  /^_{5,}\s*$/,                           // Outlook separator
  /^from:\s.+/i,                          // forwarded header block
  /^sent from my /i,                      // mobile signature
  /^--\s*$/,                              // signature delimiter
];

// Keep only what the person actually typed: drop everything from the first
// quote/signature marker onward.
export function extractReplyBody(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    if (QUOTE_MARKERS.some((re) => re.test(line.trim()))) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

const REJECT_WORDS = /\b(reject(?:ed|s)?|declin(?:e|ed|es)|den(?:y|ied|ies)|refus(?:e|ed|es)|disapprov(?:e|ed|es))\b/;
const APPROVE_WORDS = /\b(approv(?:e|ed|es)|approval granted|yes|ok|okay|go ahead|granted|agreed)\b/;
const NEGATED_APPROVAL = /\b(?:not|never|cannot|can'?t|won'?t|do not|don'?t|doesn'?t)\s+(?:be\s+|yet\s+)?(?:approv(?:e|ed)|ok|okay|granted)\b/;
const HEDGES = /\b(but|however|unless|except|only if|only for|provided|once|after|before|until|pending|wait|hold|question|clarif\w*|confirm with)\b/;
const PLAIN_NO = /^no\b(?!\s+(problem|worries|worry|issue|issues|objection|objections|concern|concerns)\b)/;

export function parseReplyDecision(text) {
  const body = extractReplyBody(text);
  if (!body || body.length > 300) return 'unclear';

  // Judge only the first few non-empty lines.
  const firstLines = body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5).join(' ');
  const normalized = firstLines.toLowerCase().replace(/[^a-z0-9?'\s]/g, ' ').replace(/\s+/g, ' ').trim();

  if (!normalized || normalized.includes('?')) return 'unclear';

  const rejects = REJECT_WORDS.test(normalized) || NEGATED_APPROVAL.test(normalized) || PLAIN_NO.test(normalized);
  const approves = APPROVE_WORDS.test(normalized);

  if (HEDGES.test(normalized)) return 'unclear';

  if (NEGATED_APPROVAL.test(normalized) && !REJECT_WORDS.test(normalized)) return 'reject';
  if (rejects && !approves) return 'reject';
  if (rejects && approves) return 'unclear';
  if (approves) return 'approve';
  return 'unclear';
}
