export type AgentToolKind = "read" | "action" | "handoff" | "connector";

/** Apps an advisor connects through Composio (backend /api/v1/connectors). */
export type ConnectorApp = "gmail" | "googlecalendar" | "googledrive";

export interface AgentToolParam {
  type: "string" | "number" | "boolean";
  description: string;
  enum?: string[];
}

export interface AgentToolSpec {
  name: string;
  kind: AgentToolKind;
  description: string;
  parameters: Record<string, AgentToolParam>;
  required?: string[];

  commandId?: string;

  handoff?: "schedule" | "add-customer" | "client-brief";

  /** kind "connector": the app the tool runs in, as the advisor. */
  connector?: ConnectorApp;
}

export const AGENT_TOOLS: AgentToolSpec[] = [

  {
    name: "get_client",
    kind: "read",
    description:
      "Look up ONE named client as a PERSON: their deal stage, status, city, phone, email. USE THIS for 'what stage is Rahul in', 'is Sofia active', 'what's Rahul's number', 'which city is Jenal in'. It returns the person, NOT their schedule — for anything about WHEN a presentation is, or WHO is running it, call list_meetings instead. Always look up rather than answering from memory; the match is phonetic, so call it even if the name sounds misheard.",
    parameters: {
      name: { type: "string", description: "Client full or partial name, e.g. 'Rahul Verma' or 'Rahul'." },
    },
    required: ["name"],
  },
  {
    name: "list_meetings",
    kind: "read",
    description:
      "The advisor's presentations. Returns the count by status AND the actual rows — each with its client, project, ADVISOR running it, date, time and status. USE THIS for anything about meetings: how many they have, what's scheduled or coming up, 'what do we see here', AND for a specific client's presentation — 'when is Rahul's viewing?', 'who's running Sofia's?', 'is Rahul's still on?'. Pass `client` to SEARCH every presentation by client or project name — this is the ONLY way to reach a row that is not among the few visible on screen, and it searches all of them, so use it instead of scrolling to hunt for someone. Never state a meeting count, date or advisor without calling this.",
    parameters: {
      status: {
        type: "string",
        description: "Optional status filter.",
        enum: ["Live", "Scheduled", "Completed", "Canceled", "all"],
      },
      client: {
        type: "string",
        description:
          "Search all presentations by client or project name, e.g. 'Tapaswin' or 'Lodha'. Matching is phonetic, so pass it even if the name may have been misheard.",
      },
    },
  },
  {
    name: "list_clients",
    kind: "read",
    description:
      "The advisor's clients, BY NAME, with each one's deal stage, city and status. USE THIS when they ask WHO their clients are and want an ANSWER: 'name them', 'who are my clients', 'who's in inquiry', 'who have I got', 'read them out'. dashboard_summary only counts them — it cannot name them, and answering 'I can't list their names' when they asked for exactly that is a failure. If instead they want to SEE the page — 'show me my clients', 'take me to my clients', 'open my portfolio' — that is navigate to /customers, not this. Pass `stage` to narrow it.",
    parameters: {
      stage: {
        type: "string",
        description: "Optional deal-stage filter.",
        enum: ["inquiry", "vsv_scheduled", "vsv_done", "offer", "negotiation", "closed_won", "closed_lost", "all"],
      },
    },
  },
  {
    name: "dashboard_summary",
    kind: "read",
    description:
      "Top-level numbers: total/active/completed presentations, total clients, and how many clients sit in each deal stage. USE THIS for broad performance questions: 'how am I doing', 'how's my pipeline', 'give me a summary', 'how many clients do I have'. It returns NUMBERS only — to MOVE to a page use navigate instead.",
    parameters: {},
  },

  {
    name: "navigate",
    kind: "action",
    commandId: "navigate",
    description:
      "Move the advisor to a page. USE THIS for any instruction to go, open, show, pull up, take me to, or see a page. Match their words to a route: dashboard/overview/home = /, presentations/meetings = /meetings, calendar/diary/'my schedule'/'my week'/'my month'/'what's my week look like' = /meetings/calendar, clients/customers/portfolio/'book of business' = /customers, pipeline/funnel/stages = /pipeline, team/advisors = /admin/team, roles = /admin/roles, permissions = /admin/permissions, templates = /settings/templates, presentation/meeting reports = /reports/meetings, ADVISOR reports = /reports/advisors, activity reports = /reports/activities. DO NOT call this if you cannot tell which page they mean, or if the instruction is cut off ('go to') — ask them instead. DO NOT call this for questions ABOUT a page.",
    parameters: {
      path: {
        type: "string",
        description:
          "Exact route, e.g. /meetings/calendar. Must be one of the routes listed in the description.",
      },
    },
    required: ["path"],
  },
  {
    name: "scroll",
    kind: "action",
    commandId: "scroll",
    description:
      "Move their view on the page they are already on. CALL THIS EVERY TIME they ask you to move: scroll down, scroll up, go to the top, go to the bottom, show me more, keep going, a bit further. It always works. Never say you have scrolled without calling it, and never say you cannot scroll. It does NOT change page — use navigate for that. To FIND a record you cannot see, search list_meetings; scrolling shows you nothing new.",
    parameters: {
      direction: {
        type: "string",
        description: "Where to scroll.",
        enum: ["down", "up", "top", "bottom"],
      },
      amount: {
        type: "string",
        description:
          "How far, for direction up/down. 'page' scrolls a full viewport, 'little' scrolls a short distance. Defaults to page.",
        enum: ["page", "little"],
      },
    },
    required: ["direction"],
  },
  {
    name: "filter_meetings",
    kind: "action",
    commandId: "filter-meetings",
    description:
      "Open the presentations list filtered by status/advisor/project/date preset. It returns the rows that matched, so use it when they want to SEE a subset and also want to know which ones those are — 'show me the live ones', 'filter to Rohit's'.",
    parameters: {
      status: { type: "string", description: "Status filter (Live/Scheduled/Completed/Canceled/all)." },
      advisor: { type: "string", description: "Advisor name filter." },
      project: { type: "string", description: "Project/development name filter." },
    },
  },
  {
    name: "launch_portal",
    kind: "action",
    commandId: "launch-portal",
    description: "Launch the moderator presentation portal for a project.",
    parameters: { project: { type: "string", description: "Project/development name." } },
  },
  {
    name: "set_client_section",
    kind: "action",
    commandId: "set-client-section",
    description: "Switch the active section on an open client profile. Only for a client profile, never for the calendar.",
    parameters: {
      section: {
        type: "string",
        description: "Profile section.",
        enum: ["overview", "activity", "presentations", "advisor", "notes"],
      },
    },
    required: ["section"],
  },

  {
    name: "set_calendar_view",
    kind: "action",
    commandId: "set-calendar-view",
    description:
      "Switch the presentations calendar to a day, week or month view, and/or show a date. USE THIS for: 'day view', 'show me the week', 'कैलेंडर को डे में बदलो', 'go to the 21st on the calendar'. Opens the calendar if it is not open. Resolve relative dates ('tomorrow', '21 तारीख') yourself.",
    parameters: {
      view: { type: "string", description: "Calendar view.", enum: ["day", "week", "month"] },
      date: { type: "string", description: "Optional date to show, as YYYY-MM-DD. Leave out to keep the date on screen." },
    },
    required: ["view"],
  },

  {
    name: "cancel_presentation",
    kind: "action",
    commandId: "cancel-presentation",
    description:
      "Cancel a client's presentation. USE THIS for: cancel/drop/call off/scrap Rahul's meeting, 'Rahul can't make it', 'he's pulled out'. IT DOES NOT CANCEL ANYTHING YET — it returns a summary you must read back as a question and get a spoken yes for, and only THEN call confirm_action. Never call confirm_action in the same turn.",
    parameters: {
      client: { type: "string", description: "Client name whose presentation to cancel." },
      date: { type: "string", description: "Optional date to disambiguate, e.g. '12 July'." },
    },
    required: ["client"],
  },
  {
    name: "reschedule_presentation",
    kind: "action",
    commandId: "reschedule-presentation",
    description:
      "Move a client's presentation to a new date/time. USE THIS for: reschedule, move, push, shift, bump, 'make it Friday instead'. Resolve relative times ('tomorrow at 4', 'next Monday') into an ISO date yourself. IT DOES NOT MOVE ANYTHING YET — read the returned summary back as a question, get a spoken yes, and only then call confirm_action.",
    parameters: {
      client: { type: "string", description: "Client name whose presentation to move." },
      start_time: {
        type: "string",
        description:
          "New date and time as an ISO 8601 string, e.g. 2026-07-15T15:00:00. Resolve relative words like 'tomorrow at 3' yourself.",
      },
    },
    required: ["client", "start_time"],
  },
  {
    name: "set_deal_stage",
    kind: "action",
    commandId: "set-deal-stage",
    description:
      "Change a client's deal stage. USE THIS for: 'mark Jenal as closed won', 'they signed', 'we won it', 'we lost that one', 'move Rahul to negotiation', 'she's made an offer'. It SAVES AT ONCE (no yes needed): say in one line what was saved, the name exactly as saved, so they hear a mistake; a fix is just another call.",
    parameters: {
      client: { type: "string", description: "Client name." },
      stage: {
        type: "string",
        description: "Target deal stage.",
        enum: [
          "inquiry",
          "vsv_scheduled",
          "vsv_done",
          "offer",
          "negotiation",
          "closed_won",
          "closed_lost",
        ],
      },
    },
    required: ["client", "stage"],
  },
  {
    name: "confirm_action",
    kind: "action",
    commandId: "confirm-action",
    description:
      "Apply or discard the change you already read back to them. Call with confirm true ONLY after they clearly said yes/go ahead/do it, and confirm false if they said no/leave it. NEVER call this in the same turn you staged a change, and NEVER call it if you have not read a summary back and heard an answer.",
    parameters: {
      confirm: {
        type: "boolean",
        description: "true if the advisor confirmed, false if they declined.",
      },
    },
    required: ["confirm"],
  },
  {
    name: "add_client_note",
    kind: "action",
    commandId: "add-client-note",
    description:
      "Save a note on a client's profile. USE THIS for: 'note that...', 'jot down...', 'remember that Sofia wants a lower floor', 'add a note on Rahul'. Applies immediately, no confirmation needed.",
    parameters: {
      client: { type: "string", description: "Client name." },
      note: { type: "string", description: "The note text to save." },
    },
    required: ["client", "note"],
  },

  {
    name: "schedule_presentation",
    kind: "action",
    commandId: "schedule-presentation",
    description:
      "Book a presentation. USE THIS for: schedule/book/set up/arrange a presentation, meeting or viewing. You need FOUR things — the client, the project, the date and the time. Ask the advisor for whatever they have not told you, one short question at a time, in their own language. NEVER invent any of them. Call this only once you have all four; it books NOTHING yet — it reads the booking back as a question, and you wait for a spoken yes before calling confirm_action. The phone and email are pulled from the CRM automatically, so never ask for them.",
    parameters: {
      client: { type: "string", description: "Client name. Required." },
      project: { type: "string", description: "Development/project name. Required." },
      date: { type: "string", description: "Date as YYYY-MM-DD; resolve 'tomorrow', '21st', 'next Friday' yourself. Required." },
      time: { type: "string", description: "Time with AM/PM ('8 PM', '10:30 AM') or 24-hour ('20:00'). Required." },
    },
    required: ["client", "project", "date", "time"],
  },
  {
    name: "add_customer",
    kind: "action",
    commandId: "add-customer",
    description:
      "Add a client to the portfolio, or add a phone, email or city to a client you already have (pass their saved name plus the new detail: 'his email is …' right after adding someone means THIS, never send_email). USE THIS for: add a customer/client/lead, 'new lead', 'put someone on my books', 'her number is …'. The NAME is the only thing you need — ask for it if they have not said it. Phone, email and city are OPTIONAL: offer to take them, but if the advisor does not have them or wants to skip, go ahead without. Never demand a phone number. It SAVES AT ONCE (no yes needed): say in one line what was saved, the name exactly as saved, so they hear a mistake; a fix is just another call. Exception: when the result says needsConfirmation (the name sounds like a client they already have), read it back and wait for a yes before confirm_action.",
    parameters: {
      name: { type: "string", description: "Client full name, ALWAYS in English letters, even when they speak Hindi (तपस्विन → Tapaswin)." },
      email: { type: "string", description: "Email if given." },
      phone: { type: "string", description: "Phone if given." },
      city: { type: "string", description: "City if given." },
    },
  },
  {
    name: "rename_client",
    kind: "action",
    commandId: "rename-client",
    description:
      "Change a client's name. USE THIS when a name was saved wrong or misheard: 'it's Tapaswin, not Tapaswan', 'fix the spelling', 'rename Rahul to Rahul Verma'. Pass the name as it is saved now in `client`. It SAVES AT ONCE (no yes needed): say in one line what was saved, the name exactly as saved, so they hear a mistake; a fix is just another call.",
    parameters: {
      client: { type: "string", description: "The client's name as currently saved." },
      new_name: { type: "string", description: "The correct full name, in English letters (तपस्विन → Tapaswin)." },
    },
    required: ["client", "new_name"],
  },
  {
    name: "client_brief",
    kind: "handoff",
    handoff: "client-brief",
    description:
      "Open a client's profile and read out a full brief on them. USE THIS when they want depth on one person: 'tell me about Rahul', 'brief me on Sofia', 'open Jenal's profile', 'walk me through number two'. For a single fact (just their stage, just their city) use get_client instead — this one navigates.",
    parameters: { client: { type: "string", description: "Client full or partial name." } },
    required: ["client"],
  },

  {
    name: "search_knowledge",
    kind: "read",
    description:
      "Search what was SAID and WRITTEN before: presentation transcripts, the advisor's presentation notes, client notes, the advisor's EARLIER CONVERSATIONS WITH YOU, and — if the advisor turned it on — their emails with clients. For 'what did I ask you about Rahul yesterday?' leave out `client` unless they name one. USE THIS for anything about what a client said, asked, wanted, liked, worried about or agreed to — 'what did Rahul say about parking?', 'what's Sofia's budget?', 'did Priya ask for a discount?', 'what did Arjun email about?'. Pass `client` whenever they name one. Answer ONLY from the returned text and mention when it was said. If nothing returned answers it, say you have no record of that — never fill the gap.",
    parameters: {
      query: { type: "string", description: "The question in their words, e.g. 'what did he say about parking'." },
      client: { type: "string", description: "Client name, if they named one. The match is phonetic." },
    },
    required: ["query"],
  },

  {
    name: "send_email",
    kind: "connector",
    connector: "gmail",
    description:
      "Send an email from the advisor's own Gmail. USE THIS for: email/mail/write to/send Rahul the brochure, 'drop Sofia a line'. Name the client in `client` and the address is looked up for you — never ask for or invent an email address. Write the subject and the full body yourself, short and professional, signed with the advisor's name. It SENDS NOTHING YET: it hands back a summary. Read it back as one short question with the gist of what the email says, get a spoken yes, then call confirm_action. Never say it was sent before confirm_action succeeds. If it returns needsConnection, tell them to tap Connect on screen.",
    parameters: {
      client: { type: "string", description: "The client's name, e.g. 'Rahul Verma'. Use this OR `to`." },
      to: { type: "string", description: "An email address the advisor dictated, only if it is not a client." },
      subject: { type: "string", description: "Subject line." },
      body: { type: "string", description: "Full plain-text email body." },
    },
    required: ["subject", "body"],
  },
  {
    name: "reply_to_email",
    kind: "connector",
    connector: "gmail",
    description:
      "Reply in the email thread with a client, from the advisor's own Gmail. USE THIS for: reply to Rahul's email, write back to Sofia, answer Priya's mail about the floor plan. It replies to the LATEST email with that client; pass `about` with a few words when they name a topic. Write the reply body from what the advisor told you; if they did not say what to reply, ask them first. It SENDS NOTHING YET: it hands back a summary and what the client last wrote. Read it back as one short question, get a spoken yes, then call confirm_action. Never say it was sent before confirm_action succeeds.",
    parameters: {
      client: { type: "string", description: "The client's name, e.g. 'Rahul Verma'." },
      about: { type: "string", description: "A few words to pick the right email, e.g. 'floor plan'. Optional." },
      body: { type: "string", description: "The reply text, short and professional, signed with the advisor's name." },
    },
    required: ["client", "body"],
  },
  {
    name: "create_calendar_event",
    kind: "connector",
    connector: "googlecalendar",
    description:
      "Add an event to the advisor's own Google Calendar and invite a client. USE THIS only once they said Google Calendar (or said yes to your offer to add it there): 'put the site visit on my Google Calendar', 'add it to Google too'. This is NOT for booking a Propley presentation — that is schedule_presentation; if they just say 'set an event', ask which. Never make up a title: if they did not say what it is, ask. Resolve relative dates yourself into a local ISO date-time. It ADDS NOTHING YET: it hands back a summary. Read it back as one short question, get a spoken yes, then call confirm_action. If something is already on their calendar at that time it says so and adds nothing: tell them. If it returns needsConnection, tell them to tap Connect on screen.",
    parameters: {
      title: { type: "string", description: "Event title, e.g. 'Site visit with Rahul Verma'." },
      start_time: { type: "string", description: "Local start, ISO 8601 without offset, e.g. '2026-11-21T16:00:00'." },
      duration_minutes: { type: "number", description: "Length in minutes. Default 60." },
      client: { type: "string", description: "Client to invite, by name. Their address is looked up for you." },
      location: { type: "string", description: "Where, if they said." },
      description: { type: "string", description: "A line of notes, if useful." },
      even_if_taken: { type: "boolean", description: "Only after they heard something is already at that time and still want a second event." },
    },
    required: ["title", "start_time"],
  },
  {
    name: "list_calendar_events",
    kind: "connector",
    connector: "googlecalendar",
    description:
      "Read the advisor's own Google Calendar. USE THIS for: what's on my Google Calendar, am I free on Friday, what do I have tomorrow, 'did it get added to my Google Calendar?'. You CAN see their Google Calendar: check it, never tell them to look themselves. For Propley presentations use list_meetings instead. Without dates it covers the next 7 days.",
    parameters: {
      from: { type: "string", description: "Start of the range, ISO date or date-time. Default now." },
      to: { type: "string", description: "End of the range, ISO date or date-time. Default 7 days after `from`." },
    },
  },
  {
    name: "search_emails",
    kind: "connector",
    connector: "gmail",
    description:
      "Read the advisor's own Gmail. USE THIS for: did Rahul reply, any email from Sofia, what did Priya write about the floor plan, did my email to Arjun go out. Name the client to see their emails both ways; add words to narrow it. Returns the latest 5 with sender, subject, date and the start of the text. You CAN see their Gmail: check it, never tell them to look themselves.",
    parameters: {
      client: { type: "string", description: "Client name, to see emails to and from them. Optional." },
      query: { type: "string", description: "Gmail search words, e.g. 'floor plan' or 'in:sent brochure'. Optional." },
    },
  },
  {
    name: "find_drive_file",
    kind: "connector",
    connector: "googledrive",
    description:
      "Find a file in the advisor's Google Drive by name, e.g. a brochure, floor plan or price sheet. Returns names and links. A link only opens for people the file is shared with.",
    parameters: {
      query: { type: "string", description: "Words from the file name, e.g. 'Lodha brochure'." },
    },
    required: ["query"],
  },
];

const TOOLS_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

export function getToolSpec(name: string): AgentToolSpec | undefined {
  return TOOLS_BY_NAME.get(name);
}

export function isHandoffTool(name: string): boolean {
  return getToolSpec(name)?.kind === "handoff";
}
