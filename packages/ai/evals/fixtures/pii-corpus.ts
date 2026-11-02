/**
 * Labelled corpus for the privacy firewall eval: note-like text with every piece of personal data
 * marked as `{{kind:value}}`, plus hard negatives (dates, versions, order numbers, hashes, ids,
 * prices, ISBNs, times, room numbers) that must not be flagged. All values are fictitious: test
 * card numbers, example domains, IBANs and IDs from public documentation formats, and API keys
 * assembled at runtime from parts so secret scanners don't flag this file.
 */
const k = (...p: string[]) => p.join('');

const SECRETS = {
  anthropic: k('sk-ant-api03-', 'Qm7Lr2Xv9Tb4Nc8Wd1Fh6Jk3Ps5Za0YeGu2Ix7Ov4Bq9'),
  openai: k('sk-proj-', 'T3bLbkFJ8nQ2rV5xW9zA1cD4eF7gH0jK3mN6pQ9sT2vW5yZ8'),
  github: k('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
  aws: k('AKIA', 'Q3JX7PL2M9TZ4KWN'),
  google: k('AIza', 'SyD8f7G2hJ4kL9mN3pQ5rS1tU6vW0xY2zA4b'),
  slack: k('xoxb-', '2048-4096-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op'),
  stripe: k('sk_live_', '51HxQ2bL8nM4kJ7vR3tY6wZ9aC2dF5gH8'),
  jwt: k('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkphbmUifQ', '.', 'S9Zs3yQ7mLk2Pw8Tn5Rv1Xc4Bf6Hg0Jd'),
  generic: k('Zq8', 'Lp2Vn6Tx9Rb3Mk7Wc1Yf5Hd4Gs0Ja8Ue'),
  password: 'Tr0ub4dor&3horse',
};

/** One labelled line per entry. */
export const PII_CORPUS: string[] = [
  // Emails
  'Send the slides to {{email:jane.doe@example.org}} before Friday.',
  'cc {{email:m.okafor+notes@uni.example.ac.uk}} and the team list.',
  'Her new address is {{email:li.wei@example.cn}} — old one bounced.',
  'Contact: {{email:support@acme-widgets.example}} (ticket 48213).',
  // Phones
  'Call {{phone:+44 20 7946 0958}} after 3pm.',
  'Dentist: {{phone:(415) 555-0132}}, moved to Tuesday.',
  'Mobile {{phone:+49 151 2345 6789}} if the train is late.',
  'WhatsApp {{phone:+91 98765 43210}} for the hostel booking.',
  'office line {{phone:212-555-0187}} ext 4',
  'phone: {{phone:0151 23456789}}',
  // Cards
  'Paid with {{card:4111 1111 1111 1111}} exp 09/28.',
  'Corporate card {{card:5555-5555-5555-4444}} for travel only.',
  'Amex {{card:378282246310005}} — ask finance to reimburse.',
  // IBAN
  'Rent goes to {{iban:DE89 3704 0044 0532 0130 00}} on the 1st.',
  'Invoice: pay to {{iban:GB82 WEST 1234 5698 7654 32}}, ref INV-2210.',
  'Transfer to {{iban:FR1420041010050500013M02606}} for the deposit.',
  // Government IDs
  'SSN {{gov_id:123-45-6789}} for the W-4 form.',
  'Her social security number is {{gov_id:219099999}} (from the old file).',
  'NI number {{gov_id:JG 10 37 23 D}} on the payslip.',
  'Aadhaar {{gov_id:2341 2341 2346}} needed for the SIM.',
  'PAN {{gov_id:ABCPE1234F}} for the tax filing.',
  'Passport no. {{gov_id:X1234567}} expires 2031.',
  'Driver\'s license number {{gov_id:D1234567}} renewal due.',
  // Secrets
  `ANTHROPIC_API_KEY={{secret:${SECRETS.anthropic}}}`,
  `openai key {{secret:${SECRETS.openai}}} (rotate monthly)`,
  `token for CI: {{secret:${SECRETS.github}}}`,
  `aws access key id {{secret:${SECRETS.aws}}}`,
  `Maps key {{secret:${SECRETS.google}}}`,
  `slack bot {{secret:${SECRETS.slack}}}`,
  `stripe {{secret:${SECRETS.stripe}}}`,
  `Authorization: Bearer {{secret:${SECRETS.jwt}}}`,
  `wifi password: {{secret:${SECRETS.password}}}`,
  `db url postgres://{{secret:admin:${SECRETS.password}}}@db.internal:5432/app`,
  `random session secret {{secret:${SECRETS.generic}}} from the old server`,
  // Addresses
  'Meet at {{address:221 Baker Street}} at noon.',
  'Ship to {{address:1600 Amphitheatre Parkway, Mountain View, CA 94043}}.',
  'New flat: {{address:Hauptstraße 12, 10115 Berlin}}',
  'Postcode {{address:SW1A 1AA}} for the visa letter.',
  'Office moved to {{address:350 Fifth Avenue}}, 21st floor.',
  // IPs
  'The NAS is at {{ip:192.168.1.20}}, printer at {{ip:192.168.1.31}}.',
  'Blocked {{ip:203.0.113.45}} after the failed logins.',
  // Names
  'Meeting with {{name:Priya Raman}} about the budget.',
  'Dr. {{name:Amelia Hart}} said to rest for a week.',
  'Ask {{name:Jonas Weber}} for the keys.',
  'Dear {{name:Ms Chen}},\nThanks for the quick reply.',
  'Hi {{name:Tomás}},\nsee below.',
  'Best regards,\n{{name:Martin Kowalski}}\n',
  'my name is {{name:Sara Lindqvist}} and I run the lab',
  'Prof. {{name:Okonkwo}} moved the exam.',
  'called {{name:Lena Fischer}} about the lease',
  // Mixed
  'Emergency: {{name:Ana Souza}} {{phone:+55 11 91234 5678}} / {{email:ana.souza@example.com.br}}',
  'Wire {{iban:NL91ABNA0417164300}} — card backup {{card:4012 8888 8888 1881}}',

  // ---- Hard negatives: nothing here is personal data -------------------------------------------
  'Lecture 7 on 2026-11-02 at 10:30, room B2.14.',
  'Order 1234 5678 9012 3456 shipped (tracking 1Z999AA10123456784).',
  'Upgrade to v1.2.3.4 then 2.10.0; build 20261102.1.',
  'Commit 3f786850e387550fdab836ed7e6dc881de23001b fixed it.',
  'UUID 6f1c2b8e-0d1e-4c2a-9a63-4a1f7c0e9b52 in the logs.',
  'Note id 01JC8ZK3V9Q7W2T5R8M4N6P0XY, page id 01JC8ZK4ABCDEFGHJKMNPQRSTV.',
  'ISBN 978-0-306-40615-7 is the textbook.',
  'Total €1,249.99 incl. VAT; 3 × 12.5 kg.',
  'Pi is 3.14159265358979 and e is 2.718281828.',
  'Call me after 5; meeting 9-11; floor 21.',
  'Homework: problems 4.12, 4.13 and 4.17 (pp. 112-118).',
  'SKU ABC-12345-XYZ restocked; part no. 778-2231-09.',
  'The hex color #FF3D5A80 and rgba(43, 35, 48, 0.11).',
  'Use the folder notes/project-alpha/drafts/final_version_2.md.',
  'Temperature 21.5°C, humidity 40%, pressure 1013 hPa.',
  'Meeting with the Product Team on Monday.',
  'Dear Team,\nplease review.',
  'Best,\nMarketing\n',
  'The Second World War ended in 1945; the Treaty of Paris in 1783.',
  'Docker image sha256:9a0b2c4d6e8f0a1b3c5d7e9f1a2b4c6d8e0f2a4b6c8d0e2f4a6b8c0d2e4f6a8b',
  'Coordinates 48.8584, 2.2945 (Eiffel Tower).',
  'Score 12-45-6789 in the bowling league? No: 12 strikes, 45 spares.',
  'Year range 2019-2024 and 1999–2003.',
  'Python version 3.12.4, Node 22.11.0, npm 10.9.0.',
  'API docs say: set api_key = <your key here>.',
  'password: required (min 12 characters).',
];

export interface GoldSpan {
  kind: string;
  value: string;
  start: number;
  end: number;
}

/** Strips the markup and returns the text with its gold spans. */
export function parseLabelled(line: string): { text: string; gold: GoldSpan[] } {
  const gold: GoldSpan[] = [];
  let text = '';
  const re = /\{\{(\w+):([\s\S]*?)\}\}/g;
  let at = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    text += line.slice(at, m.index);
    gold.push({ kind: m[1]!, value: m[2]!, start: text.length, end: text.length + m[2]!.length });
    text += m[2]!;
    at = m.index + m[0].length;
  }
  return { text: text + line.slice(at), gold };
}
