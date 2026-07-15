export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;

  // Secrets (wrangler secret put ...)
  ANTHROPIC_API_KEY: string;
  IMAGE_API_KEY: string;
  CURATE_PASSWORD: string;

  // Vars
  AUTO_APPROVE: string; // "true" | "false"
  PUBLIC_BASE_URL: string;
}

export interface Drawing {
  id: string;
  title: string;
  r2_key: string;
  media_type: string;
  description: string | null;
  style_notes: string | null;
  created_at: number;
}

export type SubmissionStatus =
  | 'queued'
  | 'generating'
  | 'rejected'
  | 'pending_review'
  | 'approved'
  | 'hidden';

// How the derivative is produced:
//   'prompt' — AI transforms the original drawing from the visitor's words.
//   'upload' — the visitor edited the drawing themselves and uploaded their version.
export type SubmissionKind = 'prompt' | 'upload';

export interface Submission {
  id: string;
  drawing_id: string;
  prompt_text: string;
  contributor_name: string | null;
  kind: SubmissionKind;
  status: SubmissionStatus;
  moderation_reason: string | null;
  attempts: number;
  claimed_at: number | null;
  override: number; // 1 = curator override: skip moderation
  created_at: number;
}

export interface Derivative {
  id: string;
  submission_id: string;
  drawing_id: string;
  r2_key: string;
  media_type: string;
  crafted_prompt: string | null;
  featured: number;
  sort_order: number;
  created_at: number;
}
