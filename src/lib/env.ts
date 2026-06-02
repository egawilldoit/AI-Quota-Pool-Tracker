import { z } from "zod";

/**
 * Public env vars — safe to import in client components.
 * Only NEXT_PUBLIC_* keys belong here.
 */
const publicEnvBaseSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
});

/**
 * Server-only env vars — must never be imported in client components.
 */
const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().url(),
  DEVTRACK_AGENT_TOKEN_PEPPER: z.string().min(1),
});

const combinedSchema = publicEnvBaseSchema.merge(serverEnvSchema).refine(
  (env) => env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  "NEXT_PUBLIC_SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required",
);

type PublicEnv = z.infer<typeof publicEnvBaseSchema>;
type ServerEnv = z.infer<typeof serverEnvSchema>;
type Env = z.infer<typeof combinedSchema>;

let parsed: Env | null = null;

function parseEnv(): Env {
  if (parsed) return parsed;

  const result = combinedSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => i.path.join("."))
      .join(", ");
    throw new Error(
      `Missing or invalid environment variables: ${missing}. Check .env.local`,
    );
  }
  parsed = result.data;
  return parsed;
}

/** Get all env vars (public + server). Server-only — not for client code. */
export function getEnv(): Env {
  return parseEnv();
}

/** Get only public env vars. Safe for client components. */
export function getPublicEnv(): PublicEnv {
  const env = parseEnv();
  return {
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  };
}

export type { PublicEnv, ServerEnv, Env };
