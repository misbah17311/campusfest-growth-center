// Things the data cannot tell you; the copilot is given the same list.
export const DATA_LIMITS = [
  "Where attendees live or study, their age or gender: no location or demographic fields exist.",
  "How many unique people saw the campaigns: reach and impressions are daily platform counts, so summing them over days double-counts people.",
  "Whether nurture emails caused registrations: emails went only to people who had not registered and there is no comparison group.",
  "Why someone was denied at the gate: check-ins record the result, not the reason.",
  "Which other campaigns influenced a person: each person has exactly one recorded source campaign, so multi-touch attribution is impossible.",
  "Whether a sponsor activation raised attendance: the sponsor data records an association only, and it is not loaded here.",
];
