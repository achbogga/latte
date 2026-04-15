import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const app = buildApp();
  await app.listen({ host, port });
  console.log(`Latte API listening on http://${host}:${port}`);
}

void main();
