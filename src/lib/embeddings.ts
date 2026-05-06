import { VoyageAIClient } from "voyageai";
import { LRUCache } from "lru-cache";

// voyage-3 outputs 1024-dim vectors by default (voyage-3-lite is locked to 512).
// Cost: ~$0.06 per 1M tokens; full 500-cafe backfill ≈ $0.02.
const VOYAGE_MODEL = "voyage-3";
export const EMBEDDING_DIM = 1024;

const queryCache = new LRUCache<string, number[]>({ max: 200 });

let client: VoyageAIClient | null = null;
function getClient(): VoyageAIClient {
  if (client) return client;
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is not set");
  }
  client = new VoyageAIClient({ apiKey });
  return client;
}

async function embedRaw(input: string, inputType: "query" | "document"): Promise<number[]> {
  const response = await getClient().embed({
    input,
    model: VOYAGE_MODEL,
    inputType,
  });
  const vector = response.data?.[0]?.embedding;
  if (!vector || vector.length !== EMBEDDING_DIM) {
    throw new Error(`Voyage returned an unexpected embedding shape (len=${vector?.length})`);
  }
  return vector;
}

export async function embedQuery(text: string): Promise<number[]> {
  const key = text.trim().toLowerCase();
  const cached = queryCache.get(key);
  if (cached) return cached;
  const vector = await embedRaw(key, "query");
  queryCache.set(key, vector);
  return vector;
}

export async function embedDocument(text: string): Promise<number[]> {
  return embedRaw(text, "document");
}
