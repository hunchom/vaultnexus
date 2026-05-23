export interface EmbedBody { model: string; input: string[]; }
interface EmbedDatum { index: number; embedding: number[]; }
interface EmbedResponse { data?: EmbedDatum[]; }

/** OpenAI-compatible /embeddings request body. */
export function buildEmbedBody(model: string, texts: string[]): EmbedBody {
  return { model, input: texts };
}

/** Parse /embeddings response → Float32Array[] in input order. `expected` = #inputs. */
export function parseEmbedResponse(resp: unknown, expected: number): Float32Array[] {
  const data = (resp as EmbedResponse)?.data;
  if (!Array.isArray(data)) throw new Error('embed response: missing data[]');
  if (data.length !== expected) {
    throw new Error(`embed response: expected ${expected} embeddings, got ${data.length}`);
  }
  const ordered = [...data].sort((a, b) => a.index - b.index);
  return ordered.map((d) => {
    if (!Array.isArray(d.embedding)) throw new Error('embed response: missing embedding[]');
    return Float32Array.from(d.embedding);
  });
}
