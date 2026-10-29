/** The onboarding draft: everything typed so far, none of it written anywhere yet. */

export type ProviderChoice = 'anthropic' | 'openai' | 'google' | 'custom';

export interface OnboardingDraft {
  choice: ProviderChoice;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Absolute path, or null for "later". */
  workspace: string | null;
}

/** The engine provider behind a choice: a custom endpoint speaks the OpenAI protocol. */
export const providerOf = (choice: ProviderChoice): string => (choice === 'custom' ? 'openai' : choice);
