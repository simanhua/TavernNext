import { createApp } from './app.js';

const app = createApp();
const host = process.env.TAVERNNEXT_HOST ?? '127.0.0.1';
const port = Number(process.env.TAVERNNEXT_PORT ?? 4312);

await app.listen({ host, port });
