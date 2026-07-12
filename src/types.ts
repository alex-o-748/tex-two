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

export interface Painting {
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

export interface Submission {
  id: string;
  painting_id: string;
  prompt_text: string;
  contributor_name: string | null;
  status: SubmissionStatus;
  moderation_reason: string | null;
  created_at: number;
}

export interface Derivative {
  id: string;
  submission_id: string;
  painting_id: string;
  r2_key: string;
  media_type: string;
  crafted_prompt: string | null;
  featured: number;
  sort_order: number;
  created_at: number;
}
