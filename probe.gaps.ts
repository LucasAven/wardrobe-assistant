import { readFileSync } from 'node:fs';
import { parseGarmentRow } from './src/worker/repo';
import { rulesFor } from './src/domain/bookRules';
import type { BodyType } from './src/domain/types';

const rows = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as unknown[];
const wardrobe = rows.map((row) => parseGarmentRow(row).garment);

const BODIES: readonly BodyType[] = ['inverted_triangle', 'rectangle'];
for (const bodyType of BODIES) {
  console.log(`\n### ${bodyType}, ${wardrobe.length} live garments`);
  for (const rule of rulesFor(bodyType)) {
    if (rule.kind !== 'garment' || rule.severity !== 'prefer') continue;
    const report = rule.slots.map((slot) => {
      const owned = wardrobe.filter((g) => g.slot === slot);
      return { slot, owned: owned.length, pass: owned.filter((g) => rule.test(g)).length };
    });
    const gaps = report.filter((r) => r.pass === 0);
    if (gaps.length === 0) continue;
    console.log(
      `${rule.id} ${gaps.length === report.length ? 'TOTAL  ' : 'partial'}  ` +
        report.map((r) => `${r.slot} ${r.pass}/${r.owned}`).join('  '),
    );
  }
}
