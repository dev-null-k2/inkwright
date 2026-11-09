/**
 * Meeting templates: the shape enhanced notes take (sections and what goes in each), and
 * recipes: saved prompts run on one meeting or many (a follow-up email, a PRD, coaching…).
 * Built-in ones live here; your own are in `ai/meetings/library.json` (library.ts).
 */

export interface TemplateSection {
  heading: string;
  /** What belongs in the section (given to the AI). */
  guide: string;
  /** Items are action items (owner, done). */
  actions?: boolean;
}

export interface MeetingTemplate {
  id: string;
  name: string;
  description: string;
  sections: TemplateSection[];
  /** Words in an event title that suggest this template (case-insensitive regex source). */
  match?: string;
  /** Extra instructions for the AI. */
  context?: string;
  builtIn?: boolean;
  updatedAt?: number;
}

const actions: TemplateSection = { heading: 'Action items', guide: 'Concrete next steps agreed in the meeting, each with its owner when one was named.', actions: true };

export const BUILTIN_TEMPLATES: readonly MeetingTemplate[] = [
  {
    id: 'general', name: 'General meeting', description: 'Works for any meeting: what was discussed, decided and what happens next.',
    sections: [
      { heading: 'Discussion', guide: 'The main topics, grouped, with the key points under each.' },
      { heading: 'Decisions', guide: 'What was decided, and why when it was said.' },
      actions,
    ],
  },
  {
    id: 'one-on-one', name: '1:1', description: 'Manager and report: updates, blockers, feedback, growth.', match: '1:1|1-1|1 on 1|one.on.one|catch.?up|check.?in',
    sections: [
      { heading: 'Updates', guide: 'What each person shared about their work since last time.' },
      { heading: 'Blockers and concerns', guide: 'Anything in the way, and worries raised.' },
      { heading: 'Feedback', guide: 'Feedback given in either direction, in the words used where possible.' },
      { heading: 'Growth', guide: 'Career, skills and goals that came up.' },
      actions,
    ],
  },
  {
    id: 'standup', name: 'Stand-up', description: 'Per person: done, next, blocked.', match: 'stand.?up|daily|scrum|sync',
    sections: [
      { heading: 'By person', guide: 'One item per person: what they did, what they are doing next, and blockers (nested lines under the name).' },
      { heading: 'Blockers', guide: 'Every blocker raised, with who can unblock it.' },
      actions,
    ],
  },
  {
    id: 'sales-call', name: 'Sales call', description: 'Discovery for a deal: pain, budget, authority, timeline, next steps.', match: 'demo|discovery|sales|intro|prospect|deal|pricing',
    sections: [
      { heading: 'About them', guide: 'The company, the people on the call and their roles.' },
      { heading: 'Pain points', guide: 'Problems they described, in their words where possible, and the impact.' },
      { heading: 'Current solution', guide: 'What they use today and what they think of it; competitors mentioned.' },
      { heading: 'Budget, authority, timeline', guide: 'Budget, who decides and how, deadlines and buying process.' },
      { heading: 'Objections', guide: 'Concerns raised and how they were answered.' },
      actions,
    ],
  },
  {
    id: 'customer-discovery', name: 'Customer discovery', description: 'User research: context, jobs, pains, quotes, insights.', match: 'research|interview with|user|customer|feedback|usability',
    sections: [
      { heading: 'Context', guide: 'Who they are and how they work.' },
      { heading: 'Jobs and goals', guide: 'What they are trying to get done.' },
      { heading: 'Pains', guide: 'Frustrations and workarounds, with how often and how much it matters.' },
      { heading: 'Quotes', guide: 'Short memorable quotes, verbatim.' },
      { heading: 'Insights', guide: 'What this means for the product; surprises.' },
      { heading: 'Feature requests', guide: 'Things they asked for.' },
    ],
  },
  {
    id: 'interview', name: 'Hiring interview', description: 'Candidate background, signals by competency, concerns, recommendation.', match: 'interview|candidate|screen|onsite|hiring',
    sections: [
      { heading: 'Background', guide: 'The candidate’s experience as they described it.' },
      { heading: 'Strengths', guide: 'Evidence of strengths, with examples given.' },
      { heading: 'Concerns', guide: 'Gaps or red flags, with the evidence.' },
      { heading: 'Questions they asked', guide: 'What the candidate wanted to know.' },
      { heading: 'Recommendation', guide: 'Only if the interviewer said it in the meeting or wrote it; otherwise leave empty.' },
    ],
  },
  {
    id: 'investor-pitch', name: 'Investor meeting', description: 'Pitch or update: their questions, concerns, interest, next steps.', match: 'investor|vc|pitch|fund|partner meeting|board',
    sections: [
      { heading: 'About the investor', guide: 'Fund, focus, stage, people.' },
      { heading: 'Their questions', guide: 'Questions asked and how they were answered.' },
      { heading: 'Concerns', guide: 'Risks and pushback raised.' },
      { heading: 'Interest and process', guide: 'Signals of interest, their process and timeline.' },
      actions,
    ],
  },
  {
    id: 'project-kickoff', name: 'Project kickoff', description: 'Goals, scope, roles, risks, milestones.', match: 'kick.?off|kickoff|planning|scoping',
    sections: [
      { heading: 'Goals', guide: 'What success looks like.' },
      { heading: 'Scope', guide: 'In scope and explicitly out of scope.' },
      { heading: 'Roles', guide: 'Who owns what.' },
      { heading: 'Risks and open questions', guide: 'Unknowns and risks raised.' },
      { heading: 'Milestones', guide: 'Dates and deliverables mentioned.' },
      actions,
    ],
  },
  {
    id: 'retro', name: 'Retrospective', description: 'What went well, what didn’t, what to change.', match: 'retro|post.?mortem|lessons',
    sections: [
      { heading: 'Went well', guide: 'What worked.' },
      { heading: 'Didn’t go well', guide: 'What hurt, and the impact.' },
      { heading: 'Root causes', guide: 'Why, as discussed.' },
      { heading: 'Changes', guide: 'What the team will do differently.' },
      actions,
    ],
  },
  {
    id: 'design-review', name: 'Design or product review', description: 'What was reviewed, feedback, decisions, open questions.', match: 'review|crit|design|spec|prd|rfc',
    sections: [
      { heading: 'What was reviewed', guide: 'The proposal or design and its goal.' },
      { heading: 'Feedback', guide: 'Points raised, grouped by theme, with who raised them when said.' },
      { heading: 'Decisions', guide: 'What was agreed.' },
      { heading: 'Open questions', guide: 'Unresolved points.' },
      actions,
    ],
  },
  {
    id: 'lecture', name: 'Lecture or class', description: 'Key ideas, definitions, examples, what to study.', match: 'lecture|class|seminar|course|lesson|tutorial|webinar|talk',
    sections: [
      { heading: 'Key ideas', guide: 'The main concepts in the order taught.' },
      { heading: 'Definitions and formulas', guide: 'Terms defined and formulas given, exactly.' },
      { heading: 'Examples', guide: 'Worked examples and illustrations.' },
      { heading: 'To study', guide: 'Readings, homework, exam hints and deadlines mentioned.' },
    ],
  },
  {
    id: 'all-hands', name: 'All-hands or town hall', description: 'Announcements, metrics, Q&A.', match: 'all.?hands|town.?hall|company meeting|quarterly',
    sections: [
      { heading: 'Announcements', guide: 'News shared.' },
      { heading: 'Numbers', guide: 'Metrics and results mentioned, exactly.' },
      { heading: 'Q&A', guide: 'Questions asked and the answers.' },
    ],
  },
  {
    id: 'partnership', name: 'Partnership or vendor', description: 'Their offer, fit, terms, concerns, next steps.', match: 'partner|vendor|supplier|agency|contract|procurement',
    sections: [
      { heading: 'Their offer', guide: 'What they provide and how.' },
      { heading: 'Fit', guide: 'Where it fits our needs and where it doesn’t.' },
      { heading: 'Terms', guide: 'Pricing, contract and timelines mentioned.' },
      { heading: 'Concerns', guide: 'Risks raised.' },
      actions,
    ],
  },
  {
    id: 'brainstorm', name: 'Brainstorm', description: 'Ideas grouped by theme, favourites, next steps.', match: 'brainstorm|ideation|workshop|jam',
    sections: [
      { heading: 'Ideas', guide: 'Every idea, grouped by theme (themes as items, ideas nested).' },
      { heading: 'Favourites', guide: 'Ideas the group liked most, and why.' },
      actions,
    ],
  },
  {
    id: 'doctor', name: 'Appointment', description: 'For your own appointments (doctor, lawyer, advisor): what they said, instructions, follow-ups.', match: 'appointment|doctor|dr\\.|clinic|consult|lawyer|advisor',
    sections: [
      { heading: 'What they said', guide: 'The explanation or assessment, in plain words.' },
      { heading: 'Instructions', guide: 'Exactly what to do, with amounts and times as said.' },
      { heading: 'Questions to follow up', guide: 'Things to ask or check later.' },
      actions,
    ],
  },
];

export const DEFAULT_TEMPLATE_ID = 'general';

/**
 * The template that fits an event or note title best: the first built-in or custom template
 * whose `match` hits the title, else General. Custom templates are tried first.
 */
export function suggestTemplate(title: string, custom: readonly MeetingTemplate[] = [], attendees = 0): MeetingTemplate {
  for (const t of [...custom, ...BUILTIN_TEMPLATES]) {
    if (!t.match) continue;
    try {
      if (new RegExp(`(^|\\W)(${t.match})(\\W|$)`, 'i').test(title)) return t;
    } catch { /* a custom pattern that doesn't compile is ignored */ }
  }
  // Two people and nothing else to go on: a 1:1 is the likeliest shape.
  if (attendees === 2) return BUILTIN_TEMPLATES.find((t) => t.id === 'one-on-one')!;
  return BUILTIN_TEMPLATES[0]!;
}

export function findTemplate(id: string | undefined, custom: readonly MeetingTemplate[] = []): MeetingTemplate {
  return custom.find((t) => t.id === id) ?? BUILTIN_TEMPLATES.find((t) => t.id === id) ?? BUILTIN_TEMPLATES[0]!;
}

// ---- Recipes ---------------------------------------------------------------------------------------

export type RecipeScope = 'meeting' | 'many';

export interface Recipe {
  id: string;
  name: string;
  description: string;
  /** The instruction run on the meeting(s). */
  prompt: string;
  /** One meeting, or several (a folder, a person, a time range, everything). */
  scope: RecipeScope;
  /** A short icon name the app maps to an icon. */
  icon?: string;
  builtIn?: boolean;
  updatedAt?: number;
}

export const BUILTIN_RECIPES: readonly Recipe[] = [
  { id: 'follow-up-email', name: 'Follow-up email', icon: 'mail', scope: 'meeting', description: 'A short email to the attendees: thanks, what was agreed, next steps with owners.',
    prompt: 'Write a follow-up email to the attendees. Start with a one-line thank-you, then what was agreed and the next steps with owners and dates. Under 180 words, warm and plain. Give a subject line first as "Subject: …".' },
  { id: 'action-items', name: 'Action items', icon: 'check', scope: 'meeting', description: 'Every next step, who owns it, by when.',
    prompt: 'List every action item from the meeting as a checklist: "- [ ] task — owner — due date". Use "unassigned" or "no date" when not said. Nothing that wasn’t agreed.' },
  { id: 'decisions', name: 'Decisions log', icon: 'gavel', scope: 'meeting', description: 'What was decided, the reasons and who decided.',
    prompt: 'List the decisions made, each with the reason given and who made or agreed it. Then list questions that were raised but not decided.' },
  { id: 'tldr', name: 'TL;DR for Slack', icon: 'message', scope: 'meeting', description: 'Three to five bullets someone who missed it can read in 20 seconds.',
    prompt: 'Write a TL;DR of the meeting for a team chat: 3 to 5 short bullets, the most important first, then one line of next steps. No headings.' },
  { id: 'coach-me', name: 'Coach me', icon: 'sparkles', scope: 'meeting', description: 'How you came across: what went well, what to try next time, with moments.',
    prompt: 'Coach the note taker on how they ran or took part in this meeting: what went well, two or three specific things to try next time, each tied to a moment with its time. Be kind and direct.' },
  { id: 'prd', name: 'Write a PRD', icon: 'file', scope: 'meeting', description: 'A product brief from what was discussed: problem, users, requirements, open questions.',
    prompt: 'Draft a product requirements document from the discussion: problem, who it is for, goals and non-goals, requirements (must, should, could), open questions and risks. Only what the meeting supports; mark gaps as "to decide".' },
  { id: 'objections', name: 'Objections and answers', icon: 'shield', scope: 'meeting', description: 'For sales calls: every objection, how it was handled, how to handle it better.',
    prompt: 'List every objection or concern the other side raised, how it was answered in the meeting, and a stronger answer to use next time.' },
  { id: 'feature-requests', name: 'Feature requests', icon: 'lightbulb', scope: 'many', description: 'Everything customers asked for across meetings, grouped and counted.',
    prompt: 'Collect every feature request or product complaint across these meetings. Group similar ones, count how many meetings raised each, and cite each meeting. Most requested first.' },
  { id: 'weekly-recap', name: 'Weekly recap', icon: 'calendar', scope: 'many', description: 'The week in meetings: decisions, progress, risks, what’s open.',
    prompt: 'Write a recap of these meetings for the week: key decisions, progress, risks and open action items with owners. Cite the meeting for each point.' },
  { id: 'person-prep', name: 'What do I owe them?', icon: 'users', scope: 'many', description: 'Open promises and topics with the people in these meetings.',
    prompt: 'From these meetings, list what I promised each person and what they promised me that is still open, and topics to bring up next time. Cite the meeting for each.' },
  { id: 'quotes', name: 'Best quotes', icon: 'quote', scope: 'many', description: 'Memorable verbatim quotes, with who said them and when.',
    prompt: 'Pick the most insightful or memorable verbatim quotes from these meetings, with who said them when known, and cite the meeting and time.' },
  { id: 'themes', name: 'Themes and trends', icon: 'trend', scope: 'many', description: 'What keeps coming up, and what changed over time.',
    prompt: 'Find the recurring themes across these meetings, how they changed over time, and anything that contradicts an earlier meeting. Cite meetings.' },
];

export function findRecipe(id: string, custom: readonly Recipe[] = []): Recipe | null {
  return custom.find((r) => r.id === id) ?? BUILTIN_RECIPES.find((r) => r.id === id) ?? null;
}
