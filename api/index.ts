/**
 * Vercel Serverless Function catch-all handler for /api/*
 *
 * Vercel compiles this file at deploy time using the @vercel/node builder.
 * It imports the compiled Express app (backend/dist/app.js) and passes
 * Vercel's req/res objects directly into it — Express handles the routing.
 *
 * Why this works: Vercel's VercelRequest/VercelResponse extend Node's native
 * IncomingMessage/ServerResponse, which is exactly what Express expects.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Import the compiled Express app. The `export default app` in backend/src/app.ts
// is compiled to backend/dist/app.js by the vercel-build step.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../backend/dist/app').default;

export default function handler(req: VercelRequest, res: VercelResponse) {
  // Feed Vercel's req/res into Express's router
  return app(req, res);
}
