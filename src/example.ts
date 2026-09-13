import type { EvidenceSource } from './contracts';

export const exampleTranscript = `# A first discovery call · sample

**[00:00] Seller:** Thanks for making time. Can you walk me through how your team handles new customer requests today?
**[00:07] Customer:** A request comes in by email. Someone copies it into a spreadsheet, then sends it to the right person. We get about 20 a day.
**[00:17] Seller:** Where does that process get stuck most often?
**[00:23] Customer:** We spend about six hours a week copying information. Requests sometimes disappear between teams.
**[00:34] Seller:** What happened the last time a request disappeared?
**[00:40] Customer:** Last Thursday a customer waited three days. I only found out when they called me directly.
**[00:50] Seller:** We could automate the handoff and keep an audit trail. You would see which person needs to act.
**[00:58] Customer:** We tried an automation tool last year. It was unreliable, so the team went back to the spreadsheet.
**[01:08] Seller:** What specifically went wrong with that tool?
**[01:14] Customer:** It sometimes sent a request to the wrong person. Nobody noticed until the customer chased us.
**[01:25] Seller:** So the important part is being able to review a handoff and catch mistakes. How would your team want to approve a request?
**[01:34] Customer:** Let us check the destination before sending it. But what would something like that cost?
**[01:44] Seller:** A small pilot would be $500. We would start with one request type and measure the time spent on it.
**[01:52] Customer:** That sounds expensive. We already pay for several tools.
**[02:01] Seller:** Which cost are you comparing it with: the current software, or the time your team spends on the process?
**[02:09] Customer:** Mostly the software. But six hours a week is a lot. I would need to show the difference to my partner.
**[02:20] Seller:** What would your partner need to see before considering a pilot?
**[02:26] Customer:** Evidence that requests reach the correct person. Our security team will also ask where customer data goes.
**[02:37] Seller:** Which customer fields have to stay within your systems?
**[02:43] Customer:** Names and account numbers. And we would need a way to review errors without exposing that data.
**[02:54] Seller:** Let's return to the handoff. Could we test one request type using anonymized examples before touching live customer data?
**[03:03] Customer:** Yes. That would address most of my concern about reliability.
**[03:12] Seller:** Would you and your partner be available Tuesday at 2 pm to review five examples together?
**[03:19] Customer:** Tuesday at 2 works. I will bring five examples, and my partner will join.
**[03:28] Seller:** Great. We will use those examples to agree on what a correct handoff looks like and whether a pilot makes sense.
`;

export const internalTrialEvidence: EvidenceSource[] = [{
  id: 'internal-replay-trial',
  title: 'A recorded reliability trial',
  passage: 'Post-fix soak completed the full 20-min call: 40 cycles, no crash, RSS max 37.5MB (flat). Staleness FAILS late-call: alternating 90s brain timeouts from cycle ~35 → gaps >90s between dashboard updates.',
  outcome: 'An internal 20-minute replay completed without a crash. Late guidance still exceeded the latency target.',
  topicTags: ['reliability', 'automation', 'trust', 'proof'],
  sourceLabel: 'Call Copilot · recorded verification, 15 July 2026',
}];
