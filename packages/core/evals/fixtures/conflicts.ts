/**
 * Labelled sentence pairs for the contradiction linter eval. `conflict: true` pairs contradict
 * (a value breaking a limit, two limits, two dates for one event, a reversed decision);
 * `false` pairs look alike but don't (values within limits, different things measured in the same
 * unit, plans changed on purpose, different currencies, closeness within tolerance…). `sameTag`
 * puts both notes under one tag, as notes about one project usually are.
 *
 * Positives the rules are known to miss are kept (marked `hard`): recall is measured honestly.
 */
export interface ConflictCase {
  a: string;
  b: string;
  conflict: boolean;
  sameTag?: boolean;
  hard?: boolean;
}

export const CONFLICT_CASES: ConflictCase[] = [
  // ---- contradictions ----
  { a: 'Latency must stay under 50 ms.', b: 'The new pipeline averages 110 ms.', conflict: true, sameTag: true },
  // Unrelated notes: which pipeline? The rules leave this to the model (grey zone).
  { a: 'Latency must stay under 50 ms.', b: 'The new pipeline averages 110 ms.', conflict: true, hard: true },
  { a: 'Page load must be under 2 s.', b: 'Page load currently averages 3.4 s.', conflict: true },
  { a: 'The API p95 must not exceed 300 ms.', b: 'API p95 is 450 ms in the latest benchmark.', conflict: true },
  { a: 'Memory usage must stay below 512 MB.', b: 'Memory usage hit 900 MB during the import.', conflict: true },
  { a: 'The budget for the offsite is at most $5k.', b: 'The offsite will cost $7,200.', conflict: true, sameTag: true },
  { a: 'Uptime must be at least 99.9%.', b: 'Uptime last quarter was 99.2%.', conflict: true },
  { a: 'The APK must be under 30 MB.', b: 'The APK size is 41 MB now.', conflict: true },
  { a: 'Error rate must stay below 1%.', b: 'The error rate is 3.5% after the release.', conflict: true },
  { a: 'The launch is on Dec 3.', b: 'Launch is December 10.', conflict: true, sameTag: true },
  { a: 'The exam is on 2026-12-14.', b: 'Exam date: December 16.', conflict: true, sameTag: true },
  { a: 'We decided to use Postgres for the queue.', b: 'We decided not to use Postgres for the queue.', conflict: true },
  { a: 'Test coverage must be at least 80%.', b: 'Coverage is 64% on main.', conflict: true },
  { a: 'Cold start must stay under 800 ms.', b: 'Cold start averages 1.6 s on the Pixel 7.', conflict: true },
  { a: 'The bundle must be under 250 KB.', b: 'The bundle is 410 KB.', conflict: true },
  { a: 'Response time should be below 200 ms.', b: 'Response time measured 350 ms in staging.', conflict: true },
  { a: 'Battery must last at least 10 hours.', b: 'The battery lasts 7 hours in the field test.', conflict: true },
  { a: 'Training should take no more than 3 hours.', b: 'Training took 5 hours yesterday.', conflict: true },
  { a: 'Throughput must be at least 1000 rps.', b: 'Throughput is 620 rps.', conflict: true },
  { a: 'We will use React for the dashboard.', b: 'We decided against React for the dashboard.', conflict: true },
  { a: 'Delivery must take at most 3 days.', b: 'Delivery takes 5 days on average.', conflict: true },
  { a: 'The demo is on Nov 20.', b: 'The demo is on Nov 27.', conflict: true, sameTag: true },
  { a: 'Search must return in under 100 ms.', b: 'Search takes 240 ms with the new index.', conflict: true },
  { a: 'Rent must stay under $2,000 a month.', b: 'The new flat costs $2,400 a month.', conflict: true, hard: true },
  { a: 'The upload limit is 25 MB.', b: 'Uploads of 40 MB must work.', conflict: true, hard: true },

  // ---- look-alikes that are not contradictions ----
  { a: 'Latency must stay under 50 ms.', b: 'The pipeline averages 30 ms.', conflict: false, sameTag: true },
  { a: 'The bundle is 110 MB.', b: 'Latency must stay under 50 ms.', conflict: false },
  { a: 'The launch is on Dec 3.', b: 'The launch moved to Dec 10.', conflict: false, sameTag: true },
  { a: 'The build takes 3 days.', b: 'Latency must stay under 50 ms.', conflict: false },
  { a: 'Memory must stay below 512 MB.', b: 'The download is 2 GB.', conflict: false },
  { a: 'The budget is $5k.', b: 'The budget is €5k.', conflict: false },
  { a: 'Our team has 5 engineers.', b: 'The office has 12 desks.', conflict: false },
  { a: 'Lunch costs $12.', b: 'The conference ticket costs $400.', conflict: false },
  { a: 'Rent is $2,000 a month.', b: 'The car costs $25,000.', conflict: false },
  { a: 'The API p95 is 120 ms.', b: 'The API p95 is 125 ms.', conflict: false },
  { a: 'The exam is on Dec 14.', b: 'The essay is due on Dec 20.', conflict: false, sameTag: true },
  { a: 'We decided to use Postgres.', b: 'We decided to use Redis for caching.', conflict: false },
  { a: 'Page load must be under 2 s.', b: 'Page load averages 1.4 s.', conflict: false },
  { a: 'Coverage must be at least 80%.', b: 'Coverage is 86%.', conflict: false },
  { a: 'Uptime must be at least 99.9%.', b: 'The error rate is 0.5%.', conflict: false },
  { a: 'The flight takes 9 hours.', b: 'The meeting must end within 1 hour.', conflict: false },
  { a: 'Latency was 300 ms in March.', b: 'Latency is now 40 ms after the rewrite.', conflict: false },
  { a: 'Training should take no more than 3 hours.', b: 'Training took 2 hours.', conflict: false },
  { a: 'Battery must last at least 10 hours.', b: 'Charging takes 2 hours.', conflict: false },
  { a: 'Max upload size is 25 MB.', b: 'The installer is 80 MB.', conflict: false },
  { a: 'The demo is on Nov 20.', b: 'The review is on Nov 27.', conflict: false, sameTag: true },
  { a: 'We decided not to ship the beta.', b: 'We decided not to ship the beta in December.', conflict: false },
  { a: 'Throughput must be at least 1000 rps.', b: 'Throughput is 1400 rps.', conflict: false },
  { a: 'The design doc is 12 pages.', b: 'The spec is 30 pages.', conflict: false },
  { a: 'Delivery must take at most 3 days.', b: 'Delivery took 2 days.', conflict: false },
  { a: 'Sprint length is 2 weeks.', b: 'The vacation is 3 weeks.', conflict: false },
  { a: 'Postgres p99 latency is 15 ms.', b: 'Kafka p99 latency is 40 ms.', conflict: false, sameTag: true },
  { a: 'The Android app must be under 30 MB.', b: 'The iOS app is 45 MB.', conflict: false, sameTag: true },
  { a: 'Search must return in under 100 ms.', b: 'Indexing takes 240 ms per document.', conflict: false },
  { a: 'Is latency under 50 ms?', b: 'The pipeline averages 110 ms.', conflict: false },
  { a: 'The gym membership is $40 a month.', b: 'Groceries are about $400 a month.', conflict: false },
  { a: 'The dentist appointment is on Dec 3.', b: 'The launch is on Dec 10.', conflict: false },
  { a: 'Our SLA is 99.9% uptime.', b: 'Uptime was 99.95% in October.', conflict: false },
];
