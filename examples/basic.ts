/**
 * Minimal library usage. Run with:  npx tsx examples/basic.ts
 *
 * Prereq: `gcloud auth application-default login` (or set
 * GOOGLE_APPLICATION_CREDENTIALS) so ADC can find cloud-platform credentials.
 */
import { seedProject } from '../src/index.js';

const result = await seedProject({
  // projectId omitted → a unique "seed-xxxxxxxxxxxx" id is generated
  displayName: 'My Gemini App',
  apis: ['generativelanguage.googleapis.com', 'aiplatform.googleapis.com'],
  credentials: { serviceAccount: true, oauthClient: false },
  outputDir: './credentials',
});

console.log(JSON.stringify(result, null, 2));
